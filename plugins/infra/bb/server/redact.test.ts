import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./redact.ts";

const cases: [string, string][] = [
  ["ssh pve1 env API_TOKEN=abc123 run", "ssh pve1 env API_TOKEN=<redacted> run"],
  ["DB_PASSWORD='p a s s' psql -h 10.0.0.5", "DB_PASSWORD=<redacted> psql -h 10.0.0.5"],
  ["export AWS_SECRET_ACCESS_KEY=xyz && aws s3 ls", "export AWS_SECRET_ACCESS_KEY=<redacted> && aws s3 ls"],
  ["mysql -h db --password=hunter2 -e 'select 1'", "mysql -h db --password=<redacted> -e 'select 1'"],
  ["vault login --token s.abcdef", "vault login --token <redacted>"],
  ["curl -H 'Authorization: Bearer eyJhbGciOi' https://pve1:8006/api2/json/version", "curl -H 'Authorization: Bearer <redacted>' https://pve1:8006/api2/json/version"],
  ["curl -H \"Authorization: PVEAPIToken=bb-view@pve!infra=1234-5678\" https://pve1:8006/", "curl -H \"Authorization: PVEAPIToken=bb-view@pve!infra=<redacted>\" https://pve1:8006/"],
  ["curl -u root:toor https://pve1:8006/", "curl -u root:<redacted> https://pve1:8006/"],
  ["psql postgresql://app:s3cret@10.0.0.5/db", "psql postgresql://app:<redacted>@10.0.0.5/db"],
  ["sshpass -p hunter2 ssh root@pve1 uptime", "sshpass -p <redacted> ssh root@pve1 uptime"],
  ["PASSWORD=hunter2 ./deploy.sh", "PASSWORD=<redacted> ./deploy.sh"],
  ["ssh pve1 'TOKEN=abc systemctl restart app'", "ssh pve1 'TOKEN=<redacted> systemctl restart app'"],
  ["mysql -u root -ptoor -h db -e 'select 1'", "mysql -u root -p<redacted> -h db -e 'select 1'"],
  ["openssl enc -aes256 -pass pass:hunter2 -in f", "openssl enc -aes256 -pass pass:<redacted> -in f"],
  // Untouched: ports, hostnames, ordinary variables, and the -p of ssh.
  ["ssh -p 2222 pve1 'pct exec 201 -- ls'", "ssh -p 2222 pve1 'pct exec 201 -- ls'"],
  ["HOST=pve1 ssh $HOST uptime", "HOST=pve1 ssh $HOST uptime"],
  ["grep -r TOKEN_FILE src/", "grep -r TOKEN_FILE src/"],
];

for (const [input, expected] of cases) test(`redacts: ${input}`, () => assert.equal(redactSecrets(input), expected));
