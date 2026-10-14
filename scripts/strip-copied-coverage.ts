// Tests import a second copy of src/ from a temp directory so two module
// instances can share process state. Bun records that copy in lcov, and
// Codecov's path fixer maps it back onto src/, marking lines the copy never
// ran as misses. Drop those records before upload.
import { readFileSync, writeFileSync } from "node:fs"

const markers = [
  "cursor-shell-copies-",
  "cursor-shell-config-copy-",
  "cursor-module-graph-",
  "cursor-image-graph-",
]
const file = process.argv[2] ?? "coverage/lcov.info"
const records = readFileSync(file, "utf8").split("end_of_record\n")
const kept = records.filter(record => !markers.some(marker => record.includes(marker)))
writeFileSync(file, kept.join("end_of_record\n"))
const dropped = records.length - kept.length
console.log(`stripped ${dropped} copied-module coverage record(s) from ${file}`)
