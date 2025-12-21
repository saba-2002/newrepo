const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio");
const { z } = require("zod");

const { EC2Client, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

function resolveRegion(override) {
  return (
    override ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1"
  );
}

function safeJson(data) {
  return JSON.stringify(
    data,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  );
}

function toTextResult(text) {
  return { content: [{ type: "text", text }] };
}

async function main() {
  const server = new McpServer(
    { name: "grafana-aws-mcp", version: "0.1.0" },
    {
      instructions:
        "Tools for querying AWS (EC2, SSM). Uses standard AWS credential resolution (env/instance-role/etc).",
    }
  );

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health-check tool to verify MCP server is running.",
      outputSchema: { ok: z.boolean(), now: z.string() },
    },
    async () => ({
      structuredContent: { ok: true, now: new Date().toISOString() },
    })
  );

  server.registerTool(
    "aws_ec2_describe_instances",
    {
      title: "AWS EC2: DescribeInstances",
      description:
        "Describe EC2 instances. Optionally filter by instanceIds / paginate.",
      inputSchema: {
        region: z.string().optional(),
        instanceIds: z.array(z.string()).optional(),
        maxResults: z.number().int().positive().max(1000).optional(),
        nextToken: z.string().optional(),
      },
    },
    async (args) => {
      const region = resolveRegion(args.region);
      const client = new EC2Client({ region });
      const cmd = new DescribeInstancesCommand({
        InstanceIds: args.instanceIds,
        MaxResults: args.maxResults,
        NextToken: args.nextToken,
      });
      const resp = await client.send(cmd);
      return toTextResult(safeJson(resp));
    }
  );

  server.registerTool(
    "aws_ssm_get_parameter",
    {
      title: "AWS SSM: GetParameter",
      description:
        "Fetch a single SSM parameter by name. Set withDecryption=true for SecureString.",
      inputSchema: {
        name: z.string().min(1),
        region: z.string().optional(),
        withDecryption: z.boolean().optional(),
      },
    },
    async (args) => {
      const region = resolveRegion(args.region);
      const client = new SSMClient({ region });
      const cmd = new GetParameterCommand({
        Name: args.name,
        WithDecryption: args.withDecryption ?? false,
      });
      const resp = await client.send(cmd);
      return toTextResult(safeJson(resp));
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      // ignore
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // Stdio servers should write only protocol messages to stdout.
  // Log errors to stderr.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

