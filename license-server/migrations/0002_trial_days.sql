-- 试用码支持：有效期从首次激活起算，而非生成时起算。
-- 已部署库执行：npm run db:migrate（本地加 --local 见 db:migrate:local）。
ALTER TABLE codes ADD COLUMN trial_days INTEGER;
