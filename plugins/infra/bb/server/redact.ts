// Commands agents run are stored and shown to people and other agents. Anything that looks like a
// credential in them is replaced before storage; the command's shape stays readable.
const MASK = "<redacted>";
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;

const RULES: [RegExp, string][] = [
  // VAR=value where the name says it holds a secret: API_TOKEN=…, DB_PASSWORD=…, aws_secret_access_key=…
  [new RegExp(String.raw`(\b(?!PVEAPIToken=)[A-Za-z0-9_]*(?:PASS(?:WORD|WD|PHRASE)?|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_]*\s*=\s*)${VALUE}`, "gi"), `$1${MASK}`],
  // mysql/mariadb -p<password> (attached form only; a bare -p prompts) and openssl -pass pass:<x>
  [/(\b(?:mysql|mariadb|mysqldump|mariadb-dump)\b[^|;&\n]*?\s-p)[^\s'"-][^\s'"]*/g, `$1${MASK}`],
  [/(\s-pass\s+(?:pass|env|file|fd):)[^\s'"]+/g, `$1${MASK}`],
  // --password x, --password=x, --token x, -p x (only the long forms; -p is a port for ssh)
  [new RegExp(String.raw`(--?(?:password|passwd|passphrase|token|secret|api-?key|access-?key|client-?secret|auth-?token|bearer)(?:=|\s+))${VALUE}`, "gi"), `$1${MASK}`],
  // Authorization headers and PVE API tokens
  [/((?:Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token)\s*:\s*(?:Bearer|Basic|Token)?\s*)(?!PVEAPIToken=)[^\s"']+/gi, `$1${MASK}`],
  [/(PVEAPIToken=[^\s=]+=)[^\s"']+/gi, `$1${MASK}`],
  // user:password@ in URLs and sshpass -p
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  [new RegExp(String.raw`(\bsshpass\s+-p\s*)${VALUE}`, "g"), `$1${MASK}`],
  // curl -u user:password
  [/(\bcurl\b[^|;&\n]*?\s(?:-u|--user)\s+[^\s:'"]+:)[^\s'"]+/g, `$1${MASK}`],
];

export function redactSecrets(command: string): string {
  let out = command;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}
