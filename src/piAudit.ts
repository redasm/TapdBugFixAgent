/** Keep numerical provider usage and tool status, never private reasoning or tool payloads. */
export class PiAudit {
  private calls=0;
  private errors=0;
  private messages=0;
  private knownCosts=0;
  private cost=0;
  observe(event: Record<string, any>): void {
    if(event.type==="tool_execution_start")this.calls++;
    if(event.type==="tool_execution_end" && (event.isError===true || event.result?.isError===true))this.errors++;
    if(event.type==="message_end" && event.message?.role==="assistant"){
      this.messages++;
      const cost=event.message.usage?.cost?.total;
      if(typeof cost==="number" && Number.isFinite(cost) && cost>=0){this.knownCosts++;this.cost+=cost;}
    }
  }
  result() { return { tool_calls:this.calls,tool_errors:this.errors,assistant_messages:this.messages,
    reported_model_cost:this.messages>0 && this.knownCosts===this.messages ? this.cost : null }; }
}
