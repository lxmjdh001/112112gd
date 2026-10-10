-- Fixed proxy IP/host records share limits across ports, credentials and protocols.
UPDATE proxies SET host=CASE WHEN host LIKE '%:%'
  THEN regexp_replace(host(host::inet),'^::ffff:','')
  ELSE lower(rtrim(host,'.')) END;
-- Preserve existing account assignments; never silently overbook an upgraded IP.
WITH limits AS (
 SELECT tenant_id,host,GREATEST(MIN(max_accounts_per_platform),COALESCE((
   SELECT MAX(used) FROM (
     SELECT a.platform,count(*) AS used FROM platform_accounts a
     JOIN proxies p2 ON p2.id=a.proxy_id
     WHERE p2.tenant_id=p.tenant_id AND p2.host=p.host GROUP BY a.platform
   ) counts
 ),0)) AS maximum
 FROM proxies p GROUP BY tenant_id,host
)
UPDATE proxies p SET max_accounts_per_platform=l.maximum FROM limits l
WHERE p.tenant_id=l.tenant_id AND p.host=l.host;
CREATE INDEX proxies_tenant_host_idx ON proxies(tenant_id,host);
