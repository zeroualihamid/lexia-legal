#!/bin/sh
# Resolve Railway's internal DNS server and inject it into the nginx config so
# lexia-backend.railway.internal resolves at runtime over IPv6.
set -e

NS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
[ -z "$NS" ] && NS="8.8.8.8"
case "$NS" in
  *:*) NS="[$NS]" ;;
esac
export NGINX_RESOLVER="$NS valid=10s ipv6=on"

envsubst '$NGINX_RESOLVER' \
  < /etc/nginx/railway.conf.template \
  > /etc/nginx/conf.d/default.conf

echo "nginx resolver: $NGINX_RESOLVER"
exec nginx -g 'daemon off;'
