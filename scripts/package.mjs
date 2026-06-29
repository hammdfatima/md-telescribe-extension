import { execSync } from "node:child_process"
import { copyFileSync, mkdirSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const folderName = basename(extensionDir)
const outputDir = join(extensionDir, "dist")
const outputZip = join(outputDir, "md-telescribe-extension.zip")
const tempZip = join(tmpdir(), `md-telescribe-extension-${Date.now()}.zip`)

const excludes = [
  "node_modules",
  "dist",
  "package.json",
  "package-lock.json",
  "README.md",
  ".git",
  ".gitignore",
  "config.example.js",
  "scripts",
]

const excludeFlags = excludes
  .map((entry) => `--exclude=${folderName}/${entry}`)
  .join(" ")

mkdirSync(outputDir, { recursive: true })

execSync(
  `tar -a -c -f "${tempZip}" -C "${dirname(extensionDir)}" ${excludeFlags} ${folderName}`,
  { stdio: "inherit" },
)

try {
  unlinkSync(outputZip)
} catch {
  // Existing file may be locked briefly.
}

copyFileSync(tempZip, outputZip)
unlinkSync(tempZip)

console.log(`Extension packaged: ${outputZip}`)
