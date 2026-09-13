-- 访问时长统计（analytics/）：一天一行 / 一个本机 ID 一行，心跳到达时累加秒数。
-- 建表：npx.cmd wrangler d1 execute touhou-stats --file=schema.sql --remote
--
-- 口径见 README.md：day 按 **UTC+8** 切天（由 Worker 算好写进来），seconds 是「标签页在前台可见」的秒数。
-- 身份键是 pid（本机随机 ID）；name 只作展示 —— 玩家在「设置 → 玩家资料」里填的昵称，**没填就是空串**
-- （不能在写入时统一成一个占位文本，否则两个没填昵称的人会被看板并成同一条）。

CREATE TABLE IF NOT EXISTS playtime (
  day        TEXT    NOT NULL,  -- YYYY-MM-DD（UTC+8）
  pid        TEXT    NOT NULL,  -- 本机随机 ID（localStorage: touhou2.stats.v1）
  name       TEXT    NOT NULL,  -- 昵称，只用于展示；没填＝空串；同一个人改名会另起一行
  seconds    INTEGER NOT NULL,  -- 当天累计在线秒数
  first_seen INTEGER NOT NULL,  -- 当天第一次心跳的毫秒时间戳
  last_seen  INTEGER NOT NULL,  -- 最近一次心跳的毫秒时间戳
  PRIMARY KEY (day, pid)
);

CREATE INDEX IF NOT EXISTS idx_playtime_day ON playtime (day);
