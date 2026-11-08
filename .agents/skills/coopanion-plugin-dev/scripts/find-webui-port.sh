#!/usr/bin/env bash
# 探测 Coopanion WebUI 端口:在 Coopanion 进程监听的本地端口里,
# 找返回 "WebUI" 页面的那个(其它端口是 DSH Bridge WS 之类的内部服务)。
# 输出:webui 基址(每行一个,取第一个即可);找不到时退出码 1。
set -u

pids=$(tasklist //FO CSV 2>/dev/null | grep -i coopanion | awk -F'","' '{print $2}' | tr -d '"' | tr -d ' ')
if [ -z "$pids" ]; then
  echo "Coopanion 未在运行" >&2
  exit 1
fi

found=""
for pid in $pids; do
  while read -r addr; do
    case "$addr" in
      127.0.0.1:*|[::1]:*) ;;
      *) continue ;;
    esac
    port="${addr##*:}"
    case "$port" in ''|*[!0-9]*) continue ;; esac
    body=$(curl -s --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null | head -c 2000)
    case "$body" in
      *"WebUI"*) case "$found" in *"http://127.0.0.1:$port/"*) ;; *) found="$found http://127.0.0.1:$port/" ;; esac ;;
    esac
  done < <(netstat -ano 2>/dev/null | grep "LISTENING" | grep " $pid\$" | awk '{print $2}' | sort -u)
done

if [ -z "$found" ]; then
  echo "未找到 WebUI 端口" >&2
  exit 1
fi
for url in $found; do echo "$url"; done
exit 0
