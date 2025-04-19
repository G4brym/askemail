import { EmailMessage } from "cloudflare:email";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types/experimental";
import { generateText, tool } from "ai";
import { marked } from "marked";
import { createMimeMessage } from "mimetext";
import PostalMime, { type Email } from "postal-mime";
import { D1QB } from "workers-qb";
import { z } from "zod";
import { MAX_EMAILS_PER_DAY, MODEL_NAME } from "./configs";
import { SYSTEM_PROMPT_RESPONSE } from "./prompts";

type ModelResponse = { response: string; subject: string; html: string };

export default {
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		try {
			const email = await PostalMime.parse(message.raw);
			await handleNewEmail(message, email, env, ctx);
		} catch (e: any) {
			console.error(
				JSON.stringify({
					name: e.name,
					messages: e.messages,
					stack: e.stack,
				}),
			);
			message.setReject("Internal Error, this error will get send back to the AI for it to fix itself, try again soon!");
		}
	},
};

async function generateResponse(email: Email, env: Env, qb: D1QB): Promise<ModelResponse> {
	const fromAddress = email.from.address;
	if (!fromAddress) {
		throw new Error("fromAddress is missing");
	}

	const google = createGoogleGenerativeAI({
		apiKey: env.GOOGLE_AI_KEY,
	});

	const model = google(MODEL_NAME);

	let attachmentText = "No attachments received in this email";

	const textEncoder = new TextEncoder();
	if (email.attachments.length > 0) {
		attachmentText = "";
		const rawAttachments: { name: string; blob: Blob }[] = [];

		for (const attachment of email.attachments) {
			if (attachment.content instanceof ArrayBuffer) {
				const blob = new Blob([attachment.content], {
					type: attachment.mimeType,
				});
				rawAttachments.push({
					name: attachment.filename ?? "unknown",
					blob: blob,
				});
			} else {
				const data = textEncoder.encode(attachment.content);
				const blob = new Blob([data], { type: attachment.mimeType });
				rawAttachments.push({
					name: attachment.filename ?? "unknown",
					blob: blob,
				});
			}
		}

		const markdownResp = await env.AI.toMarkdown(rawAttachments);

		for (const md of markdownResp) {
			if (md.format === "markdown") {
				attachmentText += `<attachment name="${md.name}">${md.data}</attachment>\n`;
			}
		}
	}

	const userRequest = `Received new email from user ${email.from.name} <${fromAddress}>, on date ${email.date}.
Email Subject: ${email.subject}
Email Body: ${email.html ?? email.text}`;

	const { text } = await generateText({
		maxTokens: 8192,
		topK: 40,
		topP: 0.95,
		model: model,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT_RESPONSE },
			{
				role: "user",
				content: [
					{
						type: "text",
						text: attachmentText,
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "text",
						text: userRequest,
					},
				],
			},
		],
		maxSteps: 5,
		tools: {
			saveInMemory: tool({
				description: "Call this function when the user ask you to remember something",
				parameters: z.object({
					text: z.string(),
				}),
				execute: async ({ text }) => {
					console.log(`model called saveInMemory for ${fromAddress}`);

					const result = await qb
						.insert<{ id: number }>({
							tableName: "memories",
							data: {
								email: fromAddress,
								request: userRequest,
								content: text,
							},
							returning: "*",
						})
						.execute();

					const { data } = await env.AI.run("@cf/baai/bge-large-en-v1.5", {
						text: [`User Request: ${userRequest} \nLLM text saved: ${text}`],
					});
					const values = data[0];

					if (!values) {
						throw new Error("Failed to generate embedding");
					}

					await env.VECTORIZE.upsert([
						{
							id: (result.results?.id ?? "").toString(),
							values,
							namespace: fromAddress,
						},
					]);

					return { success: true };
				},
			}),
			getFromMemory: tool({
				description:
					"Call this function when the user ask you to remember something from the past. in the text property you should send what you are trying to remember",
				parameters: z.object({
					text: z.string(),
				}),
				execute: async ({ text }) => {
					console.log(`model called getFromMemory for ${fromAddress}`);

					const embeddings = await env.AI.run("@cf/baai/bge-large-en-v1.5", {
						text: text,
					});
					const vectors = embeddings.data[0];

					const vectorQuery = await env.VECTORIZE.query(vectors, {
						topK: 3,
						namespace: fromAddress,
					});
					const ids = [];
					if (vectorQuery.matches && vectorQuery.matches.length > 0 && vectorQuery.matches[0]) {
						for (const match of vectorQuery.matches) {
							if (match.score > 0.65) {
								ids.push(match.id);
							}
						}
					} else {
						return {
							success: false,
							error: "No matching memories found for the text received, you may try again with different text.",
						};
					}

					const memories = [];
					const rawMemories = (
						await qb
							.select<{
								id: number;
								request: string;
								content: string;
								created_at: string;
							}>("memories")
							.whereIn("id", ids)
							.all()
					).results;

					if (!rawMemories) {
						return {
							success: false,
							error: "No matching memories found for the text received, you may try again with different text.",
						};
					}

					for (const memory of rawMemories) {
						memories.push({
							memorySavedAt: memory.created_at,
							userRequestAtTheTime: memory.request,
							contextSavedAtTheTime: memory.content,
						});
					}

					return { success: true, memories: memories };
				},
			}),
		},
	});

	return {
		response: text,
		subject: `RE: ${email.subject}`,
		html: await marked.parse(text),
	};
}

async function handleNewEmail(message: ForwardableEmailMessage, email: Email, env: Env, ctx: ExecutionContext): Promise<void> {
	const qb = new D1QB(env.DB);

	console.log(`Received email from ${email.from.address}, with subject: ${email.subject}`);

	const todayEmails = await qb
		.select("emails")
		.where("from_address = ?", email.from.address)
		.where("DATE(created_at) = DATE('now')")
		.count();

	let modelResponse: ModelResponse;
	let rateLimited = false;
	if (MAX_EMAILS_PER_DAY && todayEmails.results && todayEmails.results.total > MAX_EMAILS_PER_DAY) {
		rateLimited = true;
		console.log(`Rate limited ${email.from.address} for today for using ${todayEmails.results.total} emails :/`);
		modelResponse = {
			response: `## You just reached today\'s limit for AskEmail :(
But don't worry, this will reset today at midnight UTC`,
			subject: "You just reached today's limit for AskEmail :(",
			html: await marked.parse(`## You just reached today\'s limit for AskEmail :(
But don't worry, this will reset today at midnight UTC`),
		};
	} else {
		console.log("No rate limit, starting inference");
		modelResponse = await generateResponse(email, env, qb);
	}

	const body = `${modelResponse.html}`;

	const response = createMimeMessage();
	response.setHeader("In-Reply-To", message.headers.get("Message-ID") ?? "");
	response.setSender(`AskEmail <${message.to}>`);
	response.setRecipient(message.from);
	response.setSubject(modelResponse.subject);
	response.addMessage({
		contentType: "text/html",
		data: body,
	});

	const replyMessage = new EmailMessage(message.to, message.from, response.asRaw());
	await message.reply(replyMessage);

	if (!rateLimited) {
		// Only from address is stored, to enforce the daily rate limit
		await qb
			.insert({
				tableName: "emails",
				data: {
					from_address: email.from.address as string,
				},
			})
			.execute();
	}
}
