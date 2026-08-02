import { createApiServer } from "./server.js";
import { loadApiRuntimeConfiguration } from "./runtime-config.js";
export * from "./server.js";
export * from "./desktop-link-email.js";
export * from "./security.js";
export * from "./pairings.js";
export * from "./store.js";
export * from "./storekit.js";
export * from "./runtime-config.js";
export * from "./database.js";
export * from "./apple-identity.js";
export * from "./postgres-store.js";
export * from "./postgres-session.js";
export * from "./postgres-pairings.js";
export * from "./distributed-rate-limit.js";
export * from "./apple-storekit.js";
export * from "./storekit-notifications.js";
export * from "./storekit-runtime.js";

if(process.argv[1]!==undefined&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
  try {
    const runtime=loadApiRuntimeConfiguration();
    const server=createApiServer(runtime.serverOptions);
    server.listen(runtime.port,runtime.host,()=>process.stdout.write(`Yield API listening on http://${runtime.host}:${runtime.port}\n`));
    let stopping=false;
    const stop=():void=>{if(stopping)return;stopping=true;server.close(()=>{void runtime.close().then(()=>{process.exitCode=0;}).catch((error:unknown)=>{process.stderr.write(`${error instanceof Error?error.message:"API runtime cleanup failed"}\n`);process.exitCode=1;});});};
    process.once("SIGTERM",stop);
    process.once("SIGINT",stop);
  } catch(error) {
    process.stderr.write(`${error instanceof Error?error.message:"API runtime configuration failed"}\n`);
    process.exitCode=1;
  }
}
