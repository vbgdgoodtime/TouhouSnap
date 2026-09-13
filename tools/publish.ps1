<#
.SYNOPSIS
  把「干净发布集」同步到 .publish/，再部署到 Cloudflare Pages。

.DESCRIPTION
  仓库里除了要发布的静态文件，还混着 node_modules/、.git/、_bak_phase1/、docs/、
  tests/、tools/、worker/ 这些不该上网的东西。而 Cloudflare Pages 的直传是「按目录原样
  发布」，所以在仓库根直接跑 `wrangler pages deploy .` 会连着一起传上去（约占 3000 个
  文件 46 MB，其中 _bak_phase1/ 的旧版全量代码和 docs/ 的设计文档都会变成公开 URL）。

  本脚本只挑页面真正用到的文件（白名单见 $Include），同步进 .publish/，再部署那个目录。
  白名单依据（见 index.html 里的 <script>/<link>，以及 js/ 里的运行时取图路径）：
      index.html / style.css / .nojekyll
      data/cards.js、data/locations.js                 ← index.html 直接引用
      js/*.js（game / ai / card-browser / home /
               deck-storage / deck-page / dev-page / net）
      assets/cards/*                                   ← 卡图，js 里拼路径加载
  刻意不发布 assets/source-art/（66 张未加工立绘素材，README 写明「不进页面」）。

  发布集约 70 个文件 / 4.8 MB，远低于 Cloudflare 的 20000 文件、单文件 25 MiB 上限。

  另外做两件「让玩家普通刷新就能拿到最新版」的事（手机端玩家不会、也不方便硬刷新）：
    ① **内容指纹**：把 .publish/index.html 里对 style.css / js / data 的引用改成
       `<路径>?v=<该文件内容 SHA256 的前 8 位>`（哈希现算，不是手写版本号）。仓库里的 index.html
       保持原样 —— 指纹只落在暂存副本上，本地开发与 git 里都不出现版本号。
    ② **`_headers`**（Cloudflare Pages 会读发布目录里的这个文件）：index.html 每次回源校验
       （no-cache，没变就 304），而带指纹的 js / data / style.css 让浏览器长期缓存 ——
       内容一变 URL 就变，旧缓存自然用不上。
    ③ **页面版本**：把由脚本指纹推出的 8 位版本号烘进 .publish/index.html 的
       `<meta name="page-version">`，供 js/net.js 的「旧页面自检」用 —— 页面加载时记下自己那份，
       点「🌐 联机对战」时拉一份不缓存的 index.html 比对，不一致就当场提示"下拉刷新"，
       而不是等握手时才报"双方版本不一致"（手机端标签页能活好几天，玩家不会主动刷新）。
  体检那步会强制核对「每个 js / data / style.css 都在 index.html 里带了 ?v=」与「页面版本已写入」：
  漏一个就会让玩家长期卡在旧版（immutable 连 304 都不问）或让自检静默失效，所以直接判失败而不是警告。

.PARAMETER ProjectName
  Cloudflare Pages 项目名，默认 touhousnap，站点地址 https://touhousnap.pages.dev

.PARAMETER Branch
  生产分支名，默认 main。显式传 --branch 是为了不让 wrangler 去猜当前 git 分支
  （猜错会变成预览部署 preview，不会更新正式站点）。

.PARAMETER SkipDeploy
  只重建 .publish/ 并打印体检报告，不调用 wrangler。用来在真发布前看一眼内容。

.PARAMETER KeepStaging
  不先清空 .publish/（默认每次全量重建，保证暂存目录和本地文件严格一致，
  不会残留上一次发布里的旧文件）。

.EXAMPLE
  tools\publish.cmd -SkipDeploy
  只准备 .publish/ 并列出会发布哪些文件，不部署。

.EXAMPLE
  tools\publish.cmd
  同步 + 部署到 https://touhousnap.pages.dev

.NOTES
  ⚠️ 本文件必须存成「UTF-8 **带 BOM**」：本机是 Windows PowerShell 5.1（没有 pwsh），
     没有 BOM 时它会按 ANSI（GBK）读这个脚本 —— 中文注释会把引号吃掉，一跑就报
     `Unexpected token '{'`（编辑器里看着完全正常，极易踩）。用 VSCode 保存时请选
     "UTF-8 with BOM"，或改用 `Set-Content -Encoding utf8` / .NET 的 UTF8Encoding($true) 写回。

  怎么运行（本机实测：执行策略是 Restricted，而且没装 PowerShell 7 的 pwsh，
  所以 `pwsh tools\publish.ps1` 和直接双击 .ps1 都会被拦下）—— 任选一种：
      tools\publish.cmd                                  ← 推荐，任意 shell 里都能敲
      powershell -ExecutionPolicy Bypass -File tools\publish.ps1

  首次使用前要登录一次 Cloudflare：npx.cmd wrangler login
  （本机 npm.ps1/npx.ps1 受执行策略限制，所以统一写成 npx.cmd；
    脚本会优先找全局 wrangler.cmd，找不到才退回 npx.cmd。）
#>

[CmdletBinding()]
param(
    [string]$ProjectName = 'touhousnap',
    [string]$Branch      = 'main',
    [switch]$SkipDeploy,
    [switch]$KeepStaging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 脚本在 tools/ 下，仓库根是它上一级（不依赖当前工作目录）
$Root  = Split-Path -Parent $PSScriptRoot
$Stage = Join-Path $Root '.publish'

# ---- 发布白名单：只有这里列出的路径会被上传 ----
$Include = @(
    'index.html',
    'style.css',
    '.nojekyll',
    'data',
    'js',
    'assets/cards'
)

function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

# ============================================================
# 1. 重建暂存目录
# ============================================================
Write-Head '1/3 重建暂存目录'
Write-Host "   $Stage"

if ((Test-Path -LiteralPath $Stage) -and -not $KeepStaging) {
    Remove-Item -LiteralPath $Stage -Recurse -Force
}
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

foreach ($rel in $Include) {
    $src = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $src)) {
        Write-Warning "白名单里有、但本地不存在，已跳过：$rel"
        continue
    }

    $dst  = Join-Path $Stage $rel
    $item = Get-Item -LiteralPath $src -Force

    if ($item.PSIsContainer) {
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
        # robocopy 的退出码小于 8 都算成功
        robocopy $src $dst /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy 复制失败：$rel（exit code $LASTEXITCODE）"
        }
        $copied = @(Get-ChildItem -LiteralPath $dst -Recurse -File -Force)
    }
    else {
        Copy-Item -LiteralPath $src -Destination $dst -Force
        $copied = @(Get-Item -LiteralPath $dst -Force)
    }

    $mb = [math]::Round((($copied | Measure-Object -Property Length -Sum).Sum / 1MB), 2)
    Write-Host ("   {0,-16} {1,4} 个文件 {2,7} MB" -f $rel, $copied.Count, $mb)
}

# 让 git 忽略这个暂存目录：标记放在 .publish/ 内部，就不必去改仓库根的 .gitignore
Set-Content -LiteralPath (Join-Path $Stage '.gitignore') -Value '*' -Encoding utf8

# ============================================================
# 1.5 给脚本 / 样式打内容指纹（手机端普通刷新也能拿到最新版）
# ============================================================
Write-Head '1.5/3 给脚本 / 样式打内容指纹'

$indexPath = Join-Path $Stage 'index.html'
$html      = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
$assetRe   = [regex]'((?:href|src)=)"(style\.css|(?:js|data)/[^"]+\.js)"'
$assetTags = @{}
$hitCount  = $assetRe.Matches($html).Count

# 每个引用换成「路径?v=内容哈希前 8 位」；内容没变时哈希不变 ⇒ 不会白白让缓存失效
$stamp = [System.Text.RegularExpressions.MatchEvaluator] {
    param($m)
    $rel  = $m.Groups[2].Value
    $file = Join-Path $Stage $rel
    if (-not (Test-Path -LiteralPath $file)) { return $m.Value }   # 白名单里没有它：下面的体检会报出来
    if (-not $assetTags.ContainsKey($rel)) {
        $assetTags[$rel] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.Substring(0, 8).ToLowerInvariant()
    }
    return $m.Groups[1].Value + '"' + $rel + '?v=' + $assetTags[$rel] + '"'
}
$html = $assetRe.Replace($html, $stamp)

# ---- 页面版本（<meta name="page-version">）：给 js/net.js 的「旧页面自检」用 ----
# 手机端玩家不会（也很难）刷新手动缓存，页面可以活好几天 —— 那份旧页面在联机握手时会被引擎指纹挡住，
# 但玩家只看到"双方版本不一致"，不知道该怎么办。这里把版本号烘进文档：页面加载时记下自己这份，
# 点「🌐 联机对战」时拉一份不缓存的 index.html 比对，不一致就当场提示"下拉刷新"。
# 取哈希的对象＝**打完 ?v= 指纹、还没插 meta 的整份 index.html**：这样 body 里的任何改动都换号，
# 包括"只改 index.html 文案"（如新手引导）的发布 —— 那种发布若不换号，自检会永远保持沉默。
# 先把 style.css 的指纹抹平成定值，保持原意：只改样式的那次发布不把玩家判成"旧版"。
if ($html -notmatch '</head>') { throw 'index.html 里找不到 </head>，无法写入页面版本。' }
$forVersion  = $html -replace 'style\.css\?v=[0-9a-f]{8}', 'style.css?v=unstamped'
$sha         = [System.Security.Cryptography.SHA256]::Create()
$bytes       = [System.Text.Encoding]::UTF8.GetBytes($forVersion)
$pageVersion = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').Substring(0, 8).ToLowerInvariant()
$sha.Dispose()
$html = $html -replace '</head>', ('<meta name="page-version" content="' + $pageVersion + '" />' + "`n" + '</head>')

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($indexPath, $html, $utf8NoBom)
Write-Host ("   index.html 里 {0} 处引用已带 ?v=<内容哈希前 8 位>" -f $hitCount)
Write-Host ("   页面版本 {0}（烘进 <meta name=`"page-version`">，联机入口用它自检旧页面）" -f $pageVersion)

# ---- 缓存策略 ----
# ① index.html 是「版本入口」：必须每次回源校验（用 no-cache 而不是 no-store —— 内容没变就 304，省流量）；
#    它一新鲜，下面那些带指纹的资源 URL 自然就跟着变。
# ② 带指纹的 js / data / style.css 可以放心长期缓存（URL 变了才是新内容），手机端因此少一轮校验。
# ⚠️ 生成出来的 _headers 注释刻意只写 ASCII：那个文件是给 Cloudflare 的解析器读的，
#    别让编码问题有机会把它读坏（读坏会静默丢掉全部缓存头）。
$headersText = @'
# generated by tools/publish.ps1 -- edit that script, not this file
/
  Cache-Control: no-cache, must-revalidate

/index.html
  Cache-Control: no-cache, must-revalidate

/js/*
  Cache-Control: public, max-age=31536000, immutable

/data/*
  Cache-Control: public, max-age=31536000, immutable

/style.css
  Cache-Control: public, max-age=31536000, immutable
'@
[System.IO.File]::WriteAllText((Join-Path $Stage '_headers'), $headersText, $utf8NoBom)

# ============================================================
# 2. 体检
# ============================================================
$files = @(Get-ChildItem -LiteralPath $Stage -Recurse -File -Force)
$bytes = ($files | Measure-Object -Property Length -Sum).Sum

Write-Head '2/3 发布内容体检'
Write-Host ("   文件数 {0} / 上限 20000" -f $files.Count)
Write-Host ("   总大小 {0} MB" -f [math]::Round($bytes / 1MB, 2))

if ($files.Count -gt 20000) {
    throw "文件数 $($files.Count) 超过 Cloudflare 的 20000 上限，请精简白名单。"
}
$oversize = @($files | Where-Object { $_.Length -gt 25MB })
if ($oversize.Count -gt 0) {
    throw ("有文件超过 25 MiB 单文件上限：" + (($oversize | ForEach-Object { $_.Name }) -join ', '))
}

# 指纹体检：会被长期缓存（_headers 里的 immutable）的文件必须都带 ?v= —— 漏一个就会让玩家长期卡在旧版
# （immutable 连 304 都不问），所以这里直接判失败，而不是只警告。
$shouldStamp = @('style.css')
foreach ($sub in 'js', 'data') {
    $shouldStamp += @(Get-ChildItem -LiteralPath (Join-Path $Stage $sub) -File -Filter *.js |
        ForEach-Object { $sub + '/' + $_.Name })
}
$missing = @($shouldStamp | Where-Object { $html -notmatch ([regex]::Escape($_) + '\?v=[0-9a-f]{8}') })
if ($missing.Count -gt 0) {
    throw ('index.html 里缺少带指纹的引用：' + ($missing -join '、') + ' —— 这些文件会被浏览器长期缓存，必须先补上引用或调整白名单 / _headers。')
}
Write-Host ("   指纹引用 {0} / {0} 处 ✓" -f $shouldStamp.Count)

# 页面版本体检：老页面自检全靠它，缺了不会报错、只会静默失效 ⇒ 这里判失败
if ($html -notmatch '<meta name="page-version" content="[0-9a-f]{8}" />') {
    throw 'index.html 里没有写入页面版本（<meta name="page-version">）—— js/net.js 的「旧页面自检」会静默失效。'
}
Write-Host ("   页面版本 {0} ✓" -f $pageVersion)

# 提醒：发布的是「当前工作区的文件内容」，不是某个 commit
if (Get-Command git -ErrorAction SilentlyContinue) {
    $dirty  = @(& git -C $Root status --porcelain 2>$null)
    $gitOk  = ($LASTEXITCODE -eq 0)
    if ($gitOk -and $dirty.Count -gt 0) {
        Write-Host ("   ! 工作区有 {0} 项未提交改动 —— 本次发布的是磁盘上的当前内容" -f $dirty.Count) -ForegroundColor Yellow
    }
}

if ($SkipDeploy) {
    Write-Head '3/3 已跳过部署（-SkipDeploy）'
    Write-Host '   去掉 -SkipDeploy 即可真发布：tools\publish.cmd'
    return
}

# ============================================================
# 3. 部署
# ============================================================
Write-Head '3/3 部署到 Cloudflare Pages'
Write-Host "   项目 $ProjectName / 分支 $Branch"

# 优先用全局 wrangler.cmd；没有就退回 npx.cmd（本机执行策略禁止直接跑 npm.ps1/npx.ps1）
$cli = Get-Command wrangler.cmd, wrangler -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cli) {
    $exe = $cli.Source
    $pre = @()
}
else {
    $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $npx) {
        throw '找不到 wrangler，也找不到 npx.cmd。请先安装 Node.js，或执行：npm.cmd i -g wrangler'
    }
    $exe = $npx.Source
    $pre = @('--yes', 'wrangler')
    Write-Host '   未发现全局 wrangler，改用 npx.cmd 调用（首次会自动下载）'
}

# 在仓库根执行：一是让 wrangler 认得这是个 git 工作区，二是上传的是 .publish 子目录
Push-Location $Root
try {
    & $exe @pre pages deploy .publish "--project-name=$ProjectName" "--branch=$Branch"
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Host ''
    Write-Host "部署失败（wrangler exit code $code）" -ForegroundColor Red
    Write-Host '常见原因：'
    Write-Host '  1) 还没登录 Cloudflare   → npx.cmd wrangler login'
    Write-Host "  2) 项目不存在            → npx.cmd wrangler pages project create $ProjectName"
    Write-Host '  3) 网络连不上 Cloudflare → 换网络 / 走代理后重试'
    Write-Host '  4) 想先看发布内容对不对  → tools\publish.cmd -SkipDeploy'
    exit $code
}

Write-Host ''
Write-Host "部署完成：https://$ProjectName.pages.dev" -ForegroundColor Green
Write-Host '玩家端（含手机）普通刷新即可拿到最新版：index.html 每次回源校验，脚本 / 样式 URL 带内容指纹。'
Write-Host '本机若还留着改动前的旧缓存，第一次仍需 Ctrl+F5；之后普通刷新就够。'
