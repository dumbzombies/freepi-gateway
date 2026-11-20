// Preloaded by bunfig.toml before any test module. config.ts resolves its data
// paths at import time, so isolate HOME/here before the first import: tests
// must never write into the user's real ~/.freepi-proxy.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freepi-test-home-"));
process.env.HOME = home;
process.env.FREEPI_DATA_DIR = join(home, ".freepi-proxy");
