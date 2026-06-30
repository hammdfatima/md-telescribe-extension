import { createWriteStream } from "node:fs"
import { mkdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import archiver from "archiver"

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const folderName = "md-telescribe-extension"
const outputDir = join(extensionDir, "dist")
const outputZip = join(outputDir, "md-telescribe-extension.zip")

mkdirSync(outputDir, { recursive: true })

await new Promise((resolve, reject) => {
  const output = createWriteStream(outputZip)
  const archive = archiver("zip", { zlib: { level: 9 } })

  output.on("close", () => {
    const { size } = statSync(outputZip)
    if (size < 1024) {
      reject(new Error(`Extension zip is too small (${size} bytes)`))
      return
    }
    console.log(`Extension packaged: ${outputZip} (${size} bytes)`)
    resolve(undefined)
  })

  archive.on("error", reject)
  output.on("error", reject)

  archive.pipe(output)
  archive.glob(
    "**/*",
    {
      cwd: extensionDir,
      dot: false,
      ignore: [
        "node_modules/**",
        "dist/**",
        "scripts/**",
        ".git/**",
        "package.json",
        "package-lock.json",
        "README.md",
        "config.example.js",
        ".gitignore",
      ],
    },
    { prefix: folderName },
  )
  archive.finalize()
})
