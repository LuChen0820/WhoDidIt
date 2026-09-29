#!/usr/bin/env bash
# 端到端冒烟测试：起真服务、走真 HTTP、带真 cookie
#   bash scripts/smoke.sh
# 注意：Windows 上 curl.exe 会把命令行里的中文按 GBK 转码，导致
# Content-Length 与请求体字节数不符。所以所有请求体一律先写 UTF-8 文件，
# 再用 --data-binary @file 发送。
set -u
cd "$(dirname "$0")/.."

PORT=${PORT:-8791}
B="http://127.0.0.1:$PORT"
rm -rf .smoke jar1 jar2 smoke.log .body.json

PORT=$PORT PGDATA=./.smoke node src/server.ts > smoke.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f jar1 jar2 .body.json' EXIT

for _ in $(seq 1 60); do curl -s -o /dev/null "$B/api/session" && break; sleep 0.5; done

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# field <key> —— 从 stdin 的 JSON 里取一个顶层字段
field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const o=JSON.parse(s);const v=o[process.argv[1]];
      console.log(v==null?"":(typeof v==="object"?JSON.stringify(v):v))}catch(e){console.log("")}})' "$1"
}

# req <method> <path> [body] [cookiejar] —— 打印响应体
req() {
  local m=$1 p=$2 body=${3:-'{}'} jar=${4:-}
  printf '%s' "$body" > .body.json
  local args=(--data-binary @.body.json -H 'content-type: application/json' -w '\n%{http_code}')
  [ -n "$jar" ] && args+=(-b "$jar" -c "$jar")
  curl -s -X "$m" "${args[@]}" "$B$p"
}
body_of() { sed -e '$d' <<<"$1"; }
code_of() { tail -1 <<<"$1"; }

expect() { # expect <desc> <actual> <wanted>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi
}
contains() { # contains <desc> <haystack> <needle>
  if grep -qF -- "$3" <<<"$2"; then ok "$1"; else bad "$1（输出里没有「$3」）"; fi
}

say "身份"
R=$(req POST /api/groups '{"name":"校园二手书平台","course":"软件工程","ownerName":"陈昊"}' jar1)
expect "组长建组成功" "$(code_of "$R")" "200"
GID=$(body_of "$R" | field groupId)

R=$(req GET /api/session '' jar1)
expect "组长身份可识别" "$(body_of "$R" | field role)" "owner"
expect "组名回显正确（中文没被编码搞坏）" "$(body_of "$R" | field groupName)" "校园二手书平台"

R=$(req GET /api/board '' jar1)
expect "无 cookie 访问看板被拒" "$(code_of "$(req GET /api/board)")" "401"

R=$(req POST /api/invites '{"name":"林嘉","code4":"1234"}' jar1)
TOK=$(body_of "$R" | field token)
expect "组长能生成邀请" "$(code_of "$R")" "200"

R=$(req POST /api/join "{\"token\":\"$TOK\",\"name\":\"林嘉\",\"code4\":\"0000\"}")
expect "学号后四位不对 → 拒绝" "$(code_of "$R")" "400"
R=$(req POST /api/join "{\"token\":\"$TOK\",\"name\":\"林嘉\",\"code4\":\"1234\"}" jar2)
expect "姓名学号都对 → 加入成功" "$(code_of "$R")" "200"
LID=$(body_of "$R" | field userId)
R=$(req POST /api/join "{\"token\":\"$TOK\",\"name\":\"林嘉\",\"code4\":\"1234\"}")
expect "同一链接不能用第二次" "$(code_of "$R")" "400"

say "任务生命周期"
R=$(req POST /api/tasks '{"title":"搜索页","points":4,"assigneeId":"'$LID'"}' jar1)
expect "组长建任务并指派" "$(code_of "$R")" "200"
TID=$(body_of "$R" | field id)

R=$(req POST "/api/tasks/$TID/submit" '{"links":["javascript:alert(document.cookie)"]}' jar2)
expect "javascript: 链接在接口层被拒" "$(code_of "$R")" "400"

R=$(req POST "/api/tasks/$TID/submit" '{"links":["https://figma.example/1"]}' jar2)
expect "正常 https 链接可提交" "$(code_of "$R")" "200"

R=$(req POST "/api/tasks/$TID/accept" '{}' jar2)
expect "自验自计被拒绝" "$(code_of "$R")" "400"
contains "拒绝理由说清了" "$(body_of "$R")" "不能验收自己负责的任务"

R=$(req POST "/api/tasks/$TID/accept" '{}' jar1)
expect "组长验收通过" "$(code_of "$R")" "200"

R=$(req GET "/api/tasks/$TID/evidence" '' jar2)
expect "组员能看到本组任务的痕迹" "$(code_of "$R")" "200"
contains "痕迹里有提交动作" "$(body_of "$R")" "submitted"

say "会议与出勤（防刷分）"
R=$(req POST '/api/meetings' '{"heldOn":"2026-09-20","note":"第 7 周例会"}' jar1)
expect "组长能记一场会议" "$(code_of "$R")" "200"
MID=$(body_of "$R" | field id)

R=$(req POST /api/attendance "{\"meetingId\":\"$MID\",\"targetUserId\":\"$LID\",\"kind\":\"checkin\"}" jar1)
expect "签到挂到具体会议" "$(code_of "$R")" "200"

R=$(req POST /api/attendance "{\"meetingId\":\"$MID\",\"targetUserId\":\"$LID\",\"kind\":\"checkin\"}" jar1)
expect "同一场会重复签到被拒" "$(code_of "$R")" "400"
contains "拒因说清了" "$(body_of "$R")" "已经记录过"

R=$(req POST /api/attendance "{\"targetUserId\":\"$LID\",\"kind\":\"checkin\"}" jar1)
expect "不挂会议的出勤被拒" "$(code_of "$R")" "400"

R=$(req POST /api/meetings '{"heldOn":"2026-09-20"}' jar1)
expect "同一天不能记两场会" "$(code_of "$R")" "400"

say "结算"
R=$(req GET /api/ledger '' jar1)
LED=$(body_of "$R")
expect "结算可查" "$(code_of "$R")" "200"
contains "林嘉拿到 4 分交付" "$LED" '"delivered":4'
contains "组长验收奖 0.5 但不计分" "$LED" '"review_bonus":0.5'
contains "组长总分为 0" "$LED" '"points":0,'

say "逾期（立项书承诺的第三类客观依据）"
PAST=$(date -u -d '10 days ago' +%Y-%m-%d 2>/dev/null || date -u -v-10d +%Y-%m-%d)
FUT=$(date -u -d '+5 days' +%Y-%m-%d 2>/dev/null || date -u -v+5d +%Y-%m-%d)
R=$(req POST /api/tasks "{\"title\":\"迟交的活\",\"points\":3,\"dueDate\":\"$PAST\",\"assigneeId\":\"$LID\"}" jar1)
expect "组长建一个带截止日的任务并派出去" "$(code_of "$R")" "200"
LATE=$(body_of "$R" | field id)
R=$(req POST "/api/tasks/$LATE/submit" '{"links":["https://example.com/done"]}' jar2)
expect "负责人迟交后仍可提交" "$(code_of "$R")" "200"
R=$(req POST "/api/tasks/$LATE/accept" '{}' jar1)
expect "组长验收" "$(code_of "$R")" "200"
R=$(req GET "/api/tasks/$LATE/evidence" '' jar1)
contains "逾期事实在验收那一刻被记录" "$(body_of "$R")" "overdue_recorded"

R=$(req POST /api/tasks "{\"title\":\"还没到期的活\",\"points\":2,\"dueDate\":\"$FUT\",\"assigneeId\":\"$LID\"}" jar1)
NEW=$(body_of "$R" | field id)
R=$(req POST "/api/tasks/$NEW/close" '{"reason":"不想做了"}' jar1)
expect "未到期的任务不能按逾期关闭" "$(code_of "$R")" "400"
contains "拒因说清了" "$(body_of "$R")" "还没到期"

R=$(req GET /api/ledger '' jar1)
contains "逾期扣分进了账本" "$(body_of "$R")" '"overdue":-3.5'

say "导出与可复核性"
R=$(req GET /api/export/events.csv '' jar1)
CSV=$(body_of "$R")
CSVH=$(head -1 <<<"$CSV" | sed -E 's/# ledger_hash=//')
# 必须现取：$LED 是「结算」段抓的旧快照，中间逾期段又追加了事件
APIH=$(field hash <<<"$(body_of "$(req GET /api/ledger '' jar1)")")
if [ -n "$APIH" ] && [ "${#APIH}" -eq 64 ] && [ "$CSVH" = "$APIH" ]; then
  ok "CSV 指纹与接口指纹一致（64 位十六进制）"
else
  bad "CSV 指纹对不上（api=$APIH csv=$CSVH）"
fi
contains "CSV 带校验方法说明" "$CSV" '校验方法'

R=$(req GET /api/export/report.txt '' jar1)
contains "教师版说明含组名" "$(body_of "$R")" "校园二手书平台"
contains "教师版说明含指纹" "$(body_of "$R")" "ledger_hash"

say "组间隔离"
R=$(req POST /api/groups '{"name":"B 组项目","ownerName":"王老师"}' jar2)
expect "林嘉可另建一个组" "$(code_of "$R")" "200"
R=$(req POST "/api/tasks/$TID/accept" '{}' jar2)
expect "B 组动不了 A 组的任务" "$(code_of "$R")" "403"
R=$(req GET "/api/tasks/$TID/evidence" '' jar2)
expect "B 组看不到 A 组的痕迹" "$(code_of "$R")" "403"

say "服务端健康"
if grep -q '\[500\]' smoke.log; then
  bad "出现未预期 500"; sed -n '1,40p' smoke.log
else
  ok "无未预期错误"
fi

printf '\n\033[1m通过 %d · 失败 %d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
