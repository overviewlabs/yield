import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "@whox/contracts";
import { Client } from "pg";

const databaseRoot = fileURLToPath(new URL("../../../database/", import.meta.url));

async function sqlFiles(directoryName: string): Promise<readonly string[]> {
  const directory = resolve(databaseRoot, directoryName);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => resolve(directory, entry.name))
    .sort();
  if (files.length === 0) {
    throw new DomainError("DB_SQL_FILES_REQUIRED", `No SQL files found in database/${directoryName}`, 500);
  }
  return files;
}

async function main():Promise<void>{
  const command=process.argv[2];
  if(command!=="migrate"&&command!=="seed"&&command!=="test")throw new DomainError("DB_COMMAND_INVALID","Expected migrate, seed, or test",400);
  const databaseUrl=process.env.DATABASE_URL;
  if(databaseUrl===undefined||databaseUrl.trim()==="")throw new DomainError("DATABASE_URL_REQUIRED","DATABASE_URL is required",500);
  const groups=command==="migrate"?["migrations","policies"] as const:command==="seed"?["seeds"] as const:["tests"] as const;
  const client=new Client({connectionString:databaseUrl,application_name:"whox-treasury-database-cli"});
  await client.connect();
  try {
    for(const group of groups){
      for(const file of await sqlFiles(group)){
        process.stdout.write(`Applying database/${group}/${basename(file)}\n`);
        await client.query(await readFile(file,"utf8"));
      }
    }
  } finally { await client.end(); }
}
void main().catch((error:unknown)=>{process.stderr.write(`${error instanceof Error?error.message:"Database command failed"}\n`);process.exitCode=1;});
