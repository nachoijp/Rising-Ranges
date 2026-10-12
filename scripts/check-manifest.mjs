// Checks a build's manifest before it's uploaded, so the wrong one can't go
// out: the released build (dist/) is plain "Rising Ranges" at a plain
// version (1.4.0), the beta (dist-beta/) is "Rising Ranges (beta)" at a
// -beta.n version. Usage: node scripts/check-manifest.mjs prod|beta
import { readFileSync } from "node:fs";

const channel = process.argv[2];
const path = channel === "beta" ? "dist-beta/manifest.json" : "dist/manifest.json";
const { name, version } = JSON.parse(readFileSync(path, "utf8"));

const problems = [];
if (channel === "beta") {
  if (!/ \(beta\)$/.test(name)) problems.push(`name "${name}" should end in " (beta)"`);
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) problems.push(`version "${version}" should look like 1.2.3-beta.1`);
} else {
  if (/[()]/.test(name)) problems.push(`name "${name}" has a channel in parentheses`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`version "${version}" should be a plain 1.2.3`);
}

if (problems.length > 0) {
  console.error(`${path}: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`${path}: ${name} ${version}`);
