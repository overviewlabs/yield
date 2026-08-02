import { DomainError, type BrokerCapability } from "@whox/contracts";

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export interface McpToolDefinition {
  readonly name:string; readonly title?:string; readonly description?:string;
  readonly inputSchema:Readonly<Record<string,unknown>>; readonly outputSchema?:Readonly<Record<string,unknown>>;
  readonly annotations?:Readonly<Record<string,unknown>>;
}

interface JsonRpcSuccess {readonly jsonrpc:"2.0";readonly id:string|number;readonly result:Record<string,unknown>;}
interface JsonRpcFailure {readonly jsonrpc:"2.0";readonly id:string|number|null;readonly error:{readonly code:number;readonly message:string;readonly data?:unknown};}
type JsonRpcResponse=JsonRpcSuccess|JsonRpcFailure;

export interface McpInitialization {
  readonly protocolVersion:McpProtocolVersion; readonly serverInfo:Readonly<{name:string;version:string;title?:string}>;
  readonly capabilities:Readonly<Record<string,unknown>>; readonly sessionId?:string;
}

const expectedRobinhoodTools = [
  "get_accounts","get_portfolio","get_realized_pnl","get_pnl_trade_history","search",
  "get_watchlists","get_watchlist_items","get_option_watchlist","get_popular_watchlists","create_watchlist","update_watchlist","follow_watchlist","unfollow_watchlist","add_to_watchlist","remove_from_watchlist","add_option_to_watchlist","remove_option_from_watchlist",
  "get_equity_historicals","get_equity_fundamentals","get_financials","get_equity_price_book","get_equity_technical_indicators","get_earnings_results","get_earnings_calendar","get_indexes","get_index_quotes",
  "get_equity_positions","get_equity_tax_lots","get_equity_quotes","get_equity_orders","get_equity_tradability","review_equity_order","place_equity_order","cancel_equity_order",
  "get_option_level_upgrade_info","get_option_historicals","get_option_chains","get_option_instruments","get_option_quotes","get_option_positions","get_option_orders","review_option_order","place_option_order","cancel_option_order",
  "get_scans","get_scanner_filter_specs","create_scan","run_scan","update_scan_filters","update_scan_config"
] as const;
export type ExpectedRobinhoodTool=(typeof expectedRobinhoodTools)[number];
export const EXPECTED_ROBINHOOD_TOOLS:ReadonlySet<string>=new Set(expectedRobinhoodTools);
export const LIVE_PLACEMENT_TOOLS:ReadonlySet<string>=new Set(["place_equity_order","place_option_order"]);

function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value);}
function parseRpc(value:unknown,expectedId:string|number):JsonRpcResponse{
  if(!isRecord(value)||value.jsonrpc!=="2.0"||value.id!==expectedId)throw new DomainError("MCP_PROTOCOL_ERROR","MCP response is not a matching JSON-RPC response",502);
  if(isRecord(value.error)&&typeof value.error.code==="number"&&typeof value.error.message==="string")return value as unknown as JsonRpcFailure;
  if(isRecord(value.result))return value as unknown as JsonRpcSuccess;
  throw new DomainError("MCP_PROTOCOL_ERROR","MCP response must contain exactly one result or error",502);
}

function parseSse(text:string,expectedId:string|number):JsonRpcResponse{
  const events=text.split(/\r?\n\r?\n/);let matched:JsonRpcResponse|undefined;
  for(const event of events){const data=event.split(/\r?\n/).filter((line)=>line.startsWith("data:")).map((line)=>line.slice(5).trimStart()).join("\n");if(data==="")continue;
    let value:unknown;try{value=JSON.parse(data);}catch{continue;}if(isRecord(value)&&value.id===expectedId)matched=parseRpc(value,expectedId);
  }
  if(matched===undefined)throw new DomainError("MCP_STREAM_INCOMPLETE","MCP SSE stream ended without the matching response",502);return matched;
}

function validateSessionId(value:string):string{if(value.length>256||!/^[\x21-\x7E]+$/.test(value))throw new DomainError("MCP_SESSION_INVALID","MCP session identifier is invalid",502);return value;}

function encodeMcpHeaderValue(value:string):string {
  const plain=/^[\x20-\x7E]+$/.test(value)&&value.trim()===value&&!value.startsWith("=?base64?")&&!value.endsWith("?=");
  return plain?value:`=?base64?${Buffer.from(value,"utf8").toString("base64")}?=`;
}

function customToolHeaders(schema:Readonly<Record<string,unknown>>,args:Readonly<Record<string,unknown>>):Record<string,string>{
  const headers:Record<string,string>={};const seen=new Set<string>();
  const visit=(node:Readonly<Record<string,unknown>>,value:unknown,path:string):void=>{
    const annotation=node["x-mcp-header"];
    if(annotation!==undefined){
      if(typeof annotation!=="string"||annotation===""||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(annotation)||seen.has(annotation.toLowerCase())||!(node.type==="string"||node.type==="integer"||node.type==="boolean"))throw new DomainError("MCP_TOOL_SCHEMA_INVALID",`Invalid x-mcp-header annotation at ${path}`,502);
      seen.add(annotation.toLowerCase());if(value!==undefined&&value!==null){if(typeof value==="number"&&!Number.isSafeInteger(value))throw new DomainError("MCP_ARGUMENTS_INVALID",`${path} must be a safe integer for header mirroring`,400);headers[`Mcp-Param-${annotation}`]=encodeMcpHeaderValue(String(value));}
    }
    if(isRecord(node.properties)){const record=isRecord(value)?value:{};for(const [key,child]of Object.entries(node.properties))if(isRecord(child))visit(child,record[key],`${path}.${key}`);}
  };
  visit(schema,args,"arguments");return headers;
}

function validateJsonSchemaSubset(schema:Readonly<Record<string,unknown>>,value:unknown,path="arguments"):void{
  const type=schema.type;
  if(type==="object"){
    if(!isRecord(value))throw new DomainError("MCP_ARGUMENTS_INVALID",`${path} must be an object`,400);
    const required=Array.isArray(schema.required)?schema.required.filter((item):item is string=>typeof item==="string"):[];
    for(const key of required)if(!(key in value))throw new DomainError("MCP_ARGUMENTS_INVALID",`${path}.${key} is required`,400);
    const properties=isRecord(schema.properties)?schema.properties:{};
    if(schema.additionalProperties===false)for(const key of Object.keys(value))if(!(key in properties))throw new DomainError("MCP_ARGUMENTS_INVALID",`${path}.${key} is not allowed`,400);
    for(const [key,child] of Object.entries(properties))if(key in value&&isRecord(child))validateJsonSchemaSubset(child,value[key],`${path}.${key}`);
  }else if(type==="array"){
    if(!Array.isArray(value))throw new DomainError("MCP_ARGUMENTS_INVALID",`${path} must be an array`,400);
    if(isRecord(schema.items))for(let index=0;index<value.length;index+=1)validateJsonSchemaSubset(schema.items,value[index],`${path}[${index}]`);
  }else if(type==="string"&&typeof value!=="string")throw new DomainError("MCP_ARGUMENTS_INVALID",`${path} must be a string`,400);
  else if(type==="number"&&(typeof value!=="number"||!Number.isFinite(value)))throw new DomainError("MCP_ARGUMENTS_INVALID",`${path} must be a finite number`,400);
  else if(type==="integer"&&(typeof value!=="number"||!Number.isInteger(value)))throw new DomainError("MCP_ARGUMENTS_INVALID",`${path} must be an integer`,400);
  else if(type==="boolean"&&typeof value!=="boolean")throw new DomainError("MCP_ARGUMENTS_INVALID",`${path} must be a boolean`,400);
  if(Array.isArray(schema.enum)&&!schema.enum.some((item)=>Object.is(item,value)))throw new DomainError("MCP_ARGUMENTS_INVALID",`${path} is not an allowed value`,400);
}

export interface McpClientOptions {readonly endpoint:URL;readonly accessToken:()=>Promise<string>;readonly fetcher?:typeof fetch;readonly timeoutMilliseconds?:number;}

export class McpStreamableHttpClient {
  readonly #fetcher:typeof fetch;readonly #timeout:number;readonly #tools=new Map<string,McpToolDefinition>();
  #nextId=1;#protocolVersion:McpProtocolVersion|undefined;#sessionId:string|undefined;#serverCapabilities:Readonly<Record<string,unknown>>={};
  #era:"modern"|"legacy"|undefined;#initialToolPage:Readonly<Record<string,unknown>>|undefined;
  public constructor(private readonly options:McpClientOptions){
    if(options.endpoint.protocol!=="https:")throw new DomainError("MCP_ENDPOINT_INVALID","Remote MCP endpoint must use HTTPS",500);
    this.#fetcher=options.fetcher??fetch;this.#timeout=options.timeoutMilliseconds??20_000;
  }
  public get protocolVersion():McpProtocolVersion|undefined{return this.#protocolVersion;}
  public get tools():readonly McpToolDefinition[]{return Object.freeze([...this.#tools.values()]);}
  public hasTool(name:string):boolean{return this.#tools.has(name);}

  #modernMessage(message:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>>{
    if(this.#protocolVersion!=="2026-07-28")return message;const params=isRecord(message.params)?message.params:{};
    return {...message,params:{...params,_meta:{...(isRecord(params._meta)?params._meta:{}),"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"whox-treasury-execution-worker",version:"0.1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}};
  }

  async #post(message:Readonly<Record<string,unknown>>,id:string|number|undefined):Promise<JsonRpcResponse|undefined>{
    const bodyMessage=this.#modernMessage(message);const accessToken=await this.options.accessToken();const headers:Record<string,string>={accept:"application/json, text/event-stream","content-type":"application/json",authorization:`Bearer ${accessToken}`};
    if(this.#protocolVersion!==undefined)headers["MCP-Protocol-Version"]=this.#protocolVersion;if(this.#era==="legacy"&&this.#sessionId!==undefined)headers["Mcp-Session-Id"]=this.#sessionId;
    if(this.#era==="modern"&&typeof bodyMessage.method==="string"){
      headers["Mcp-Method"]=bodyMessage.method;const params=isRecord(bodyMessage.params)?bodyMessage.params:{};
      if((bodyMessage.method==="tools/call"||bodyMessage.method==="resources/read"||bodyMessage.method==="prompts/get")&&(typeof params.name==="string"||typeof params.uri==="string"))headers["Mcp-Name"]=encodeMcpHeaderValue(String(params.name??params.uri));
      if(bodyMessage.method==="tools/call"&&typeof params.name==="string"&&isRecord(params.arguments)){const tool=this.#tools.get(params.name);if(tool!==undefined)Object.assign(headers,customToolHeaders(tool.inputSchema,params.arguments));}
    }
    const response=await this.#fetcher(this.options.endpoint,{method:"POST",headers,body:JSON.stringify(bodyMessage),redirect:"error",signal:AbortSignal.timeout(this.#timeout)});
    const receivedSession=response.headers.get("mcp-session-id");if(receivedSession!==null){const validated=validateSessionId(receivedSession);if(this.#sessionId!==undefined&&this.#sessionId!==validated)throw new DomainError("MCP_SESSION_CHANGED","MCP session changed unexpectedly",502);this.#sessionId=validated;}
    if(id===undefined){if(response.status!==202&&!response.ok)throw new DomainError("MCP_NOTIFICATION_FAILED","MCP notification was not accepted",502);return undefined;}
    if(!response.ok)throw new DomainError(response.status===401?"MCP_AUTHORIZATION_REQUIRED":"MCP_HTTP_ERROR",`MCP request failed with HTTP ${response.status}`,response.status===401?401:502);
    const contentType=response.headers.get("content-type")?.split(";",1)[0]?.trim();const text=await response.text();
    let rpc:JsonRpcResponse;if(contentType==="text/event-stream")rpc=parseSse(text,id);else{let value:unknown;try{value=JSON.parse(text);}catch{throw new DomainError("MCP_PROTOCOL_ERROR","MCP returned invalid JSON",502);}rpc=parseRpc(value,id);}
    if("error" in rpc)throw new DomainError("MCP_REMOTE_ERROR",`MCP tool server error ${rpc.error.code}: ${rpc.error.message}`,502,{remoteCode:rpc.error.code});
    return rpc;
  }

  public async initialize():Promise<McpInitialization>{
    if(this.#protocolVersion!==undefined)throw new DomainError("MCP_ALREADY_INITIALIZED","MCP client is already initialized",409);
    const modern=await this.#probeModern();if(modern!==undefined)return modern;
    this.#era="legacy";const id=this.#nextId++;const response=await this.#post({jsonrpc:"2.0",id,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"whox-treasury-execution-worker",version:"0.1.0"}}},id);
    if(response===undefined||!("result" in response))throw new DomainError("MCP_INITIALIZATION_FAILED","MCP initialization did not return a result",502);
    const version=response.result.protocolVersion;if(typeof version!=="string"||!(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version))throw new DomainError("MCP_VERSION_UNSUPPORTED",`MCP protocol version ${String(version)} is unsupported`,502);
    if(!isRecord(response.result.capabilities)||!isRecord(response.result.serverInfo)||typeof response.result.serverInfo.name!=="string"||typeof response.result.serverInfo.version!=="string")throw new DomainError("MCP_INITIALIZATION_FAILED","MCP initialization payload is invalid",502);
    this.#protocolVersion=version as McpProtocolVersion;this.#serverCapabilities=Object.freeze({...response.result.capabilities});
    await this.#post({jsonrpc:"2.0",method:"notifications/initialized"},undefined);
    return Object.freeze({protocolVersion:this.#protocolVersion,serverInfo:response.result.serverInfo as unknown as McpInitialization["serverInfo"],capabilities:this.#serverCapabilities,...(this.#sessionId===undefined?{}:{sessionId:this.#sessionId})});
  }

  async #probeModern():Promise<McpInitialization|undefined>{
    const id=this.#nextId++;const message={jsonrpc:"2.0",id,method:"tools/list",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"whox-treasury-execution-worker",version:"0.1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}};
    const accessToken=await this.options.accessToken();const response=await this.#fetcher(this.options.endpoint,{method:"POST",headers:{accept:"application/json, text/event-stream","content-type":"application/json",authorization:`Bearer ${accessToken}`,"MCP-Protocol-Version":"2026-07-28","Mcp-Method":"tools/list"},body:JSON.stringify(message),redirect:"error",signal:AbortSignal.timeout(this.#timeout)});
    if(response.status===401)throw new DomainError("MCP_AUTHORIZATION_REQUIRED","MCP authorization is required",401,{wwwAuthenticate:response.headers.get("www-authenticate")??""});
    const contentType=response.headers.get("content-type")?.split(";",1)[0]?.trim();const text=await response.text();
    if(response.ok){let rpc:JsonRpcResponse;if(contentType==="text/event-stream")rpc=parseSse(text,id);else{let value:unknown;try{value=JSON.parse(text);}catch{throw new DomainError("MCP_PROTOCOL_ERROR","MCP returned invalid JSON",502);}rpc=parseRpc(value,id);}if("error" in rpc)throw new DomainError("MCP_REMOTE_ERROR",rpc.error.message,502);
      if(!Array.isArray(rpc.result.tools))throw new DomainError("MCP_TOOL_LIST_INVALID","Modern MCP probe returned an invalid tool list",502);this.#era="modern";this.#protocolVersion="2026-07-28";this.#serverCapabilities=Object.freeze({tools:{listChanged:false}});this.#initialToolPage=rpc.result;
      return Object.freeze({protocolVersion:"2026-07-28",serverInfo:Object.freeze({name:this.options.endpoint.hostname,version:"2026-07-28"}),capabilities:this.#serverCapabilities});}
    if(![400,404,405].includes(response.status))throw new DomainError("MCP_HTTP_ERROR",`MCP modern probe failed with HTTP ${response.status}`,502);
    if(text!==""){try{const value:unknown=JSON.parse(text);if(isRecord(value)&&isRecord(value.error)){
        if(value.error.code===-32022&&isRecord(value.error.data)&&Array.isArray(value.error.data.supported)){
          const supported=value.error.data.supported.filter((item):item is string=>typeof item==="string");
          if(supported.some((version)=>MCP_PROTOCOL_VERSIONS.slice(1).includes(version as never)))return undefined;
          throw new DomainError("MCP_VERSION_UNSUPPORTED",`No mutually supported MCP protocol version; server supports ${supported.join(", ")}`,502);
        }
        if(value.error.code===-32020||value.error.code===-32601)throw new DomainError("MCP_MODERN_NEGOTIATION_FAILED",String(value.error.message??"Modern protocol negotiation failed"),502);
      }}catch(error){if(error instanceof DomainError)throw error;}}
    return undefined;
  }

  public async discoverTools(discoveredAt=new Date().toISOString()):Promise<readonly BrokerCapability[]>{
    if(this.#protocolVersion===undefined)throw new DomainError("MCP_NOT_INITIALIZED","MCP client must initialize before tool discovery",409);
    if(!("tools" in this.#serverCapabilities)){this.#tools.clear();return Object.freeze([]);}
    const found=new Map<string,McpToolDefinition>();let cursor:string|undefined;let pages=0;let page=this.#initialToolPage;this.#initialToolPage=undefined;
    do{if(pages++>=100)throw new DomainError("MCP_PAGINATION_LIMIT","MCP tool pagination exceeded the safety limit",502);let result:Readonly<Record<string,unknown>>;
      if(page!==undefined){result=page;page=undefined;}else{const id=this.#nextId++;const response=await this.#post({jsonrpc:"2.0",id,method:"tools/list",params:cursor===undefined?{}:{cursor}},id);if(response===undefined||!("result" in response))throw new DomainError("MCP_TOOL_LIST_INVALID","MCP tool list is invalid",502);result=response.result;}
      if(!Array.isArray(result.tools))throw new DomainError("MCP_TOOL_LIST_INVALID","MCP tool list is invalid",502);
      for(const value of result.tools){if(!isRecord(value)||typeof value.name!=="string"||!isRecord(value.inputSchema))continue;try{customToolHeaders(value.inputSchema,{});}catch{continue;}const tool:McpToolDefinition=Object.freeze({name:value.name,inputSchema:Object.freeze({...value.inputSchema}),
          ...(typeof value.title==="string"?{title:value.title}:{}),...(typeof value.description==="string"?{description:value.description}:{}),...(isRecord(value.outputSchema)?{outputSchema:Object.freeze({...value.outputSchema})}:{}),...(isRecord(value.annotations)?{annotations:Object.freeze({...value.annotations})}:{})});found.set(tool.name,tool);}
      cursor=typeof result.nextCursor==="string"&&result.nextCursor!==""?result.nextCursor:undefined;
    }while(cursor!==undefined);
    this.#tools.clear();for(const [name,tool]of found)this.#tools.set(name,tool);
    return Object.freeze([...found.values()].map((tool)=>Object.freeze({toolName:tool.name,inputSchema:tool.inputSchema,...(tool.outputSchema===undefined?{}:{outputSchema:tool.outputSchema}),discoveredAt,protocolVersion:this.#protocolVersion!})));
  }

  public async callTool(name:string,args:Readonly<Record<string,unknown>>):Promise<Readonly<Record<string,unknown>>>{
    const tool=this.#tools.get(name);if(tool===undefined)throw new DomainError("BROKER_CAPABILITY_UNAVAILABLE",`Broker tool ${name} is unavailable`,503,{toolName:name});
    validateJsonSchemaSubset(tool.inputSchema,args);const id=this.#nextId++;const response=await this.#post({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}},id);
    if(response===undefined||!("result" in response))throw new DomainError("MCP_TOOL_RESULT_INVALID","MCP tool result is invalid",502);
    if(response.result.isError===true)throw new DomainError("BROKER_TOOL_REJECTED",`Broker tool ${name} returned an error`,422);
    return Object.freeze({...response.result});
  }

  public capabilityDelta():{readonly availableExpected:readonly string[];readonly unavailableExpected:readonly string[];readonly unknownTools:readonly string[]}{
    const names=new Set(this.#tools.keys());return Object.freeze({availableExpected:Object.freeze(expectedRobinhoodTools.filter((name)=>names.has(name))),unavailableExpected:Object.freeze(expectedRobinhoodTools.filter((name)=>!names.has(name))),unknownTools:Object.freeze([...names].filter((name)=>!EXPECTED_ROBINHOOD_TOOLS.has(name)))});
  }
}
