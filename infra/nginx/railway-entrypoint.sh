#!/bin/sh
# Resolve Railway's internal DNS server from the container's resolv.conf and
# inject it into the nginx config so upstreams (*.railway.internal) resolve at
# runtime over IPv6. Only $NGINX_RESOLVER is substituted; nginx's own $vars are
# left intact.
set -e

NS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
[ -z "$NS" ] && NS="8.8.8.8"
# Bracket IPv6 nameservers for the nginx resolver directive.
case "$NS" in
  *:*) NS="[$NS]" ;;
esac
export NGINX_RESOLVER="$NS valid=10s ipv6=on"

envsubst '$NGINX_RESOLVER' \
  < /etc/nginx/railway.conf.template \
  > /etc/nginx/conf.d/default.conf

echo "nginx resolver: $NGINX_RESOLVER"
exec nginx -g 'daemon off;'
