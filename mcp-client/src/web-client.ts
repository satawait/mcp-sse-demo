/**
 * 这是一个Web客户端示例，用于在Node.js服务器中集成MCP客户端
 * 实际项目中可以把这部分代码整合到Next.js、Express或其他Web框架中
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Client as McpClient, } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { config } from "./config.js";
import { createAnthropicClient, createGeminiClient } from "./utils.js";
import { Anthropic } from "@anthropic-ai/sdk";
import { GoogleGenAI, FunctionDeclaration, Content } from '@google/genai';
import  { setGlobalDispatcher, ProxyAgent, getGlobalDispatcher } from 'undici';

const dispatcher = new ProxyAgent({ uri: new URL(process.env.https_proxy || 'http://127.0.0.1:1080').toString() });
const originalDispatcher = getGlobalDispatcher();
// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
    

let mcpClient: McpClient | null = null;
// let anthropicTools: any[] = [];
let geminiTools: FunctionDeclaration[] = [];
// let aiClient: Anthropic;
let aiClient: GoogleGenAI;

const app = express();

// 使用中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// 创建Anthropic客户端
aiClient = createGeminiClient(config);

// 初始化MCP客户端
async function initMcpClient() {
  if (mcpClient) return;

  try {
    console.log("正在连接到MCP服务器...");
    mcpClient = new McpClient({
      name: "mcp-client",
      version: "1.0.0",
    });

    const transport = new SSEClientTransport(new URL(config.mcp.serverUrl));

    await mcpClient.connect(transport);
    const { tools } = await mcpClient.listTools();
    // // 转换工具格式为Anthropic所需的数组形式
    // anthropicTools = tools.map((tool: any) => {
    //   return {
    //     name: tool.name,
    //     description: tool.description,
    //     input_schema: tool.inputSchema,
    //   };
    // });
    // 转换工具格式为Gemini所需的数组形式
    geminiTools = tools.map((tool) => {
      // Filter the parameters to exclude not supported keys
      // 递归过滤掉不支持的属性
      const filterUnsupportedKeys = (obj: any): any => {
        if (typeof obj !== 'object' || obj === null) return obj;
        
        if (Array.isArray(obj)) {
          return obj.map(item => filterUnsupportedKeys(item));
        }
        
        const filtered = Object.entries(obj).filter(([key]) => 
          !["additionalProperties", "$schema"].includes(key)
        );
        
        const result: any = {};
        for (const [key, value] of filtered) {
          result[key] = filterUnsupportedKeys(value);
        }
        
        return result;
      };
      
      const parameters = filterUnsupportedKeys(tool.inputSchema);
      return {
        name: tool.name,
        description: tool.description,
        parameters: parameters
      };
    });

    console.log("MCP客户端和工具已初始化完成");
  } catch (error) {
    console.error("初始化MCP客户端失败:", error);
    throw error;
  }
}

// 主页
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// 创建路由器
const apiRouter = express.Router();

// 中间件：确保MCP客户端已初始化
// @ts-ignore
apiRouter.use((req, res, next) => {
  if (!mcpClient) {
    initMcpClient().catch(console.error);
  }
  next();
});

// API: 获取可用工具列表
// @ts-ignore
apiRouter.get("/tools", async (req, res) => {
  try {
    res.json({ tools: geminiTools });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// API: 聊天请求
// @ts-ignore
apiRouter.post("/chat", async (req, res) => {
  //全局fetch调用启用代理
  setGlobalDispatcher(dispatcher);
  try {
    console.log("收到聊天请求");
    const { message, history = [] } = req.body;
    console.log(`用户消息: ${message}`);
    console.log(`历史消息数量: ${history.length}`);

    if (!message) {
      console.warn("请求中消息为空");
      return res.status(400).json({ error: "消息不能为空" });
    }

    // 构建消息历史
    const messages: Content[] = [...history, { role: "user", parts: [{ text: message }] }];
    console.log(`准备发送到AI的消息总数: ${messages.length}`);

    // 调用AI
    console.log(`开始调用AI模型: ${config.ai.defaultModel}`);
    const response = await aiClient.models.generateContent({
      model: config.ai.defaultModel,
      contents: messages,
      config: {
        tools: [{
          functionDeclarations: geminiTools
        }],
      }
    });
    console.log("AI响应成功");

    // 处理工具调用
    const hasToolUse = response.functionCalls && response.functionCalls.length > 0;

    if (hasToolUse) {
      // 处理所有工具调用
      const toolResults = [];

      for (const content of response.functionCalls) {
        const name = content.name || '';
        const toolInput = content.args as
          | { [x: string]: unknown }
          | undefined;

        try {
          // 调用MCP工具
          if (!mcpClient) {
            console.error("MCP客户端未初始化");
            throw new Error("MCP客户端未初始化");
          }
          console.log(`开始调用MCP工具: ${name}`);
          setGlobalDispatcher(originalDispatcher);
          const toolResult = await mcpClient.callTool({
            name,
            arguments: toolInput,
          });
          console.log(`工具返回结果: ${JSON.stringify(toolResult)}`);

          toolResults.push({
            name,
            result: toolResult,
          });
        } catch (error: any) {
          console.error(`工具调用失败: ${name}`, error);
          toolResults.push({
            name,
            error: error.message,
          });
        }
      }

      // 将工具结果发送回AI获取最终回复
      console.log("开始获取AI最终回复");
      const finalMessages: Content[] = [...messages, { role: "user", parts: [{ text: JSON.stringify(toolResults) }] }];
      setGlobalDispatcher(dispatcher);
      const finalResponse = await aiClient.models.generateContent({
        model: config.ai.defaultModel,
        contents: finalMessages
      });
      setGlobalDispatcher(originalDispatcher);
      console.log("获取AI最终回复成功");

      const textResponse = finalResponse.candidates?.reduce((pre, next) => pre + next.content?.parts?.map(p => p.text || '').join('') + '\n', '');
        

      res.json({
        response: textResponse,
        toolCalls: toolResults,
      });
    } else {
      // 直接返回AI回复
      const textResponse = response.candidates?.reduce((pre, next) => pre + next.content?.parts?.map(p => p.text || '').join('') + '\n', '');
       
      res.json({
        response: textResponse,
        toolCalls: [],
      });
    }
  } catch (error: any) {
    console.error("聊天请求处理失败:", error);
    res.status(500).json({ error: error.message, code: error.code || '123', stack: error.stack  });
  }
});

// API: 直接调用工具
// @ts-ignore
apiRouter.post("/call-tool", async (req, res) => {
  try {
    const { name, args } = req.body;

    if (!name) {
      console.warn("请求中工具名称为空");
      return res.status(400).json({ error: "工具名称不能为空" });
    }

    if (!mcpClient) {
      console.error("MCP客户端未初始化");
      throw new Error("MCP客户端未初始化");
    }

    const result = await mcpClient.callTool({
      name,
      arguments: args || {},
    });
    res.json({ result });
  } catch (error: any) {
    console.error("工具调用请求处理失败:", error);
    res.status(500).json({ error: error.message });
  }
});

// 注册API路由
app.use("/api", apiRouter);

// 启动服务器
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Web客户端服务器已启动，地址: http://localhost:${PORT}`);

  // 预初始化MCP客户端
  initMcpClient().catch(console.error);
});
