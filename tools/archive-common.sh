# POSIX sh 共用校验。必须检查生产命令自身状态，不能靠管道末端成功。
hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then nc_hash_line=$(sha256sum "$1") || return 1
  elif command -v openssl >/dev/null 2>&1; then nc_hash_line=$(openssl dgst -sha256 -r "$1") || return 1
  else echo "需要 sha256sum 或 openssl" >&2; return 1; fi
  nc_hash=${nc_hash_line%% *}
  [ "${#nc_hash}" = 64 ] || return 1
  case "$nc_hash" in *[!0-9a-f]*) return 1 ;; esac
  printf '%s\n' "$nc_hash"
}
