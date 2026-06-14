import { Injectable, Logger } from '@nestjs/common';
import * as vm from 'node:vm';
import axios from 'axios';

interface Tool {
  implementation_code: string;
  timeout_ms: number;
  tool_type?: string;
  endpoint?: string;
  name?: string;
}

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  async executeTool(tool: Tool, args: any): Promise<any> {
    if (tool.tool_type === 'mcp' && tool.endpoint && tool.name) {
      return this.executeMcpTool(tool.endpoint, tool.name, args);
    }
    return this.executeSandboxTool(tool.implementation_code, tool.timeout_ms, args);
  }

  private async executeSandboxTool(
    implementationCode: string,
    timeoutMs: number,
    args: any,
  ): Promise<any> {
    const context: any = {
      args,
      result: undefined,
      Math,
      Date,
      JSON,
      parseInt,
      parseFloat,
      console: {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
      setTimeout: undefined,
      setInterval: undefined,
      fetch: undefined,
      require: undefined,
      process: undefined,
    };

    vm.createContext(context);

    const script = new vm.Script(implementationCode);

    try {
      script.runInContext(context, { timeout: timeoutMs || 5000 });
    } catch (err) {
      if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new Error(`Tool execution timed out after ${timeoutMs}ms`);
      }
      throw new Error(`Tool execution error: ${err.message}`);
    }

    return context.result;
  }

  private async executeMcpTool(
    endpoint: string,
    toolName: string,
    args: any,
  ): Promise<any> {
    const url = `${endpoint}/tools/${toolName}`;
    try {
      const response = await axios.post(
        url,
        { arguments: args },
        { timeout: 30000 },
      );
      return response.data;
    } catch (err) {
      this.logger.error(`MCP tool call failed: ${url} - ${err.message}`);
      throw new Error(`MCP tool execution failed: ${err.message}`);
    }
  }
}
