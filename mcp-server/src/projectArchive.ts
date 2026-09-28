// projectArchive.ts – S37 Export/Import as single file (base64)
import { buildContext } from "./contextInjection.js";
import { commandQueue } from "./commandQueue.js";
export function exportProject(projectId="default"){
  const snap = buildContext({ projectId, snapshot:"" });
  const json = JSON.stringify(snap);
  return { exported:true, projectId, archive: Buffer.from(json).toString("base64"), size: json.length };
}
export function importProject(archive: string, projectId="default"){
  try{
    const decoded = JSON.parse(Buffer.from(archive, "base64").toString());
    commandQueue.enqueue({ tool:"run_code", command:"--import_project", args:{projectId, decoded: String(JSON.stringify(decoded).slice(0,200))}});
    return { imported:true, projectId, preview: decoded };
  }catch(e:any){ return { imported:false, error:String(e.message) }; }
}
