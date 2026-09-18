import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { codeRelations } from "../src/codeRelations.js";
import { P4Client } from "../src/p4.js";
import { hasPatchEvidence } from "../src/attemptAudit.js";
import { PiAudit } from "../src/piAudit.js";

describe("source identity and provenance", () => {
  it("invalidates cached AST after content changes and bounds root traversal", () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"relation-test-"));
    try {
      const file=path.join(root,"View.ts");
      fs.writeFileSync(file,"export class View { AdaptToViewport() {} open() { this.AdaptToViewport(); } }");
      const first=codeRelations(root,".","AdaptToViewport","symbol");
      expect(first.results).toHaveLength(1);
      expect(codeRelations(root,".","AdaptToViewport","references").results).toHaveLength(2);
      fs.writeFileSync(file,"export class View { AdaptToScreen() {} }");
      expect(codeRelations(root,".","AdaptToViewport","symbol").results).toHaveLength(0);
      expect(codeRelations(root,".","Adapt","related").results[0].source_hash).not.toBe(first.results[0].source_hash);
      expect(()=>codeRelations(root,"..","View","symbol")).toThrow("超出");
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
  it("includes real added and deleted P4 content absent from p4 diff", async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"p4-patch-test-"));
    try {
      fs.writeFileSync(path.join(root,"New.ts"),"export const x=1;");
      const client=new P4Client(root,{});
      vi.spyOn(client,"diffUnified").mockResolvedValue("");
      vi.spyOn(client,"run").mockImplementation(async args=>args[0]==="print"?"removed implementation":`... path ${path.join(root,"New.ts")}`);
      const patch=await client.candidateDiff([{depot:"//depot/New.ts",action:"add",changelist:"default",type:"text"},{depot:"//depot/Old.ts",action:"delete",changelist:"default",type:"text"}]);
      expect(patch).toContain("+export const x=1;"); expect(patch).toContain("-removed implementation");
      expect(hasPatchEvidence(patch)).toBe(true);
      expect(hasPatchEvidence("(... files differ ...)")).toBe(true);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
  it("reports only observed tool errors and treats missing provider price as unknown",()=>{
    const audit=new PiAudit();
    audit.observe({type:"tool_execution_start"}); audit.observe({type:"tool_execution_end",isError:true});
    audit.observe({type:"message_end",message:{role:"assistant",usage:{cost:{total:0.02}}}});
    expect(audit.result()).toMatchObject({tool_calls:1,tool_errors:1,reported_model_cost:0.02});
    audit.observe({type:"message_end",message:{role:"assistant"}});
    expect(audit.result().reported_model_cost).toBeNull();
  });
});
