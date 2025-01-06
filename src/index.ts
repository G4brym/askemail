import {ForwardableEmailMessage} from "@cloudflare/workers-types/experimental";
import {streamToArrayBuffer} from "./utils";
import PostalMime, {Email} from "postal-mime";
import {generateText, tool} from 'ai';
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {SYSTEM_PROMPT_RESPONSE} from "./prompts";
import {z} from "zod";
import {marked} from "marked";
import {D1QB} from "workers-qb";
import {SendRawEmailCommand, SESClient} from '@aws-sdk/client-ses'
import {FROM_ADDRESS, MAX_ATTACHMENT_SIZE_BYTES, MAX_EMAILS_PER_DAY, SUPPORTED_MIME_TYPES} from "./configs";
import {EmailMessage} from "cloudflare:email";

const mimemessage = require('mimemessage');


export default {
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		try {
			const email = await parseEmail(message);
			await handleNewEmail(message, email, env, ctx)
		} catch (e: any) {
			console.error(JSON.stringify({
				name: e.name,
				messages: e.messages,
				stack: e.stack,
			}));
			message.setReject("Internal Error, this error will get send back to the AI for it to fix itself, try again soon!");
		}
	}
}

async function generateResponse(email: Email, env: Env, qb: D1QB) {
	const fromAddress = email.from.address;
	if (!fromAddress) {
		throw new Error("fromAddress is missing");
	}

	const google = createGoogleGenerativeAI({
		apiKey: env.GOOGLE_AI_KEY,
	});

	const model = google('gemini-1.5-flash', {
		safetySettings: [
			{category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH'},
			{category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH'},
			{category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH'},
			{category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE'},
		],
	});

	const attachments = []
	let attachmentText = ""

	const textEncoder = new TextEncoder();
	if (email.attachments.length > 0) {
		let sizeUntilNow = 0

		for (const attachment of email.attachments) {
			if (!SUPPORTED_MIME_TYPES.has(attachment.mimeType.split(';')[0].toLowerCase())) {
				attachmentText += `Email Attachment filename: ${attachment.filename}, attachment mimeType: ${attachment.mimeType}, attachment description: ${attachment.description}, attachment content: This file content type is not supported, unfortunately\n`
				continue
			}

			if (attachment.content instanceof ArrayBuffer) {
				if (attachment.content.byteLength + sizeUntilNow <= MAX_ATTACHMENT_SIZE_BYTES) {
					sizeUntilNow += attachment.content.byteLength
					attachmentText += `Email Attachment filename: ${attachment.filename}, attachment mimeType: ${attachment.mimeType}, attachment description: ${attachment.description}\n`
					attachments.push({
						type: 'file',
						mimeType: attachment.mimeType,
						data: attachment.content,
					});
				} else {
					attachmentText += `Email Attachment filename: ${attachment.filename}, attachment mimeType: ${attachment.mimeType}, attachment description: ${attachment.description}, attachment content: This file size is too big, unfortunately\n`
				}
			} else {
				const data = textEncoder.encode(attachment.content)
				if (data.length + sizeUntilNow <= MAX_ATTACHMENT_SIZE_BYTES) {
					sizeUntilNow += data.length
					attachmentText += `Email Attachment filename: ${attachment.filename}, attachment mimeType: ${attachment.mimeType}, attachment description: ${attachment.description}\n`
					attachments.push({
						type: 'file',
						mimeType: attachment.mimeType,
						data: data,
					});
				} else {
					attachmentText += `Email Attachment filename: ${attachment.filename}, attachment mimeType: ${attachment.mimeType}, attachment description: ${attachment.description}, attachment content: This file size is too big, unfortunately\n`
				}
			}
		}
	}

	const userRequest = `Received new email from user ${email.from.name} <${fromAddress}>, on date ${email.date}.
Email Subject: ${email.subject}
${attachmentText}
Email Body: ${email.html ?? email.text}`

	const {text} = await generateText({
		maxTokens: 8192,
		topK: 40,
		topP: 0.95,
		model: model,
		messages: [
			{role: 'system', content: SYSTEM_PROMPT_RESPONSE},
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: userRequest
					},
					...attachments
				],
			},
		],
		maxSteps: 5,
		tools: {
			saveInMemory: tool({
				description: 'Call this function when the user ask you to remember something',
				parameters: z.object({
					text: z.string()
				}),
				execute: async ({text}) => {
					console.log(`model called saveInMemory for ${fromAddress}`)

					const result = await qb.insert<{ id: number }>({
						tableName: 'memories',
						data: {
							email: fromAddress,
							request: userRequest,
							content: text
						},
						returning: '*'
					}).execute()

					const {data} = await env.AI.run("@cf/baai/bge-large-en-v1.5", {
						text: [`User Request: ${userRequest} \nLLM text saved: ${text}`],
					});
					const values = data[0];

					if (!values) {
						throw new Error("Failed to generate embedding")
					}

					await env.VECTORIZE.upsert([
						{
							id: (result.results?.id ?? '').toString(),
							values,
							namespace: fromAddress,
						},
					]);

					return {success: true}
				},
			}),
			getFromMemory: tool({
				description: 'Call this function when the user ask you to remember something from the past. in the text property you should send what you are trying to remember',
				parameters: z.object({
					text: z.string()
				}),
				execute: async ({text}) => {
					console.log(`model called getFromMemory for ${fromAddress}`)

					const embeddings = await env.AI.run('@cf/baai/bge-large-en-v1.5', {text: text})
					const vectors = embeddings.data[0]

					const vectorQuery = await env.VECTORIZE.query(vectors, {topK: 3, namespace: fromAddress});
					let ids = [];
					if (vectorQuery.matches && vectorQuery.matches.length > 0 && vectorQuery.matches[0]) {
						for (const match of vectorQuery.matches) {
							if (match.score > 0.65) {
								ids.push(match.id)
							}
						}
					} else {
						return {
							success: false,
							error: "No matching memories found for the text received, you may try again with different text."
						}
					}

					let memories = []
					const rawMemories = (await qb.select<{
						id: number,
						request: string,
						content: string,
						created_at: string
					}>('memories')
						.whereIn('id', ids)
						.all())
						.results

					if (!rawMemories) {
						return {
							success: false,
							error: "No matching memories found for the text received, you may try again with different text."
						}
					}

					for (const memory of rawMemories) {
						memories.push({
							memorySavedAt: memory.created_at,
							userRequestAtTheTime: memory.request,
							contextSavedAtTheTime: memory.content
						})
					}

					return {success: true, memories: memories}
				},
			}),
		},
	});

	return {
		response: text,
		subject: `RE: ${email.subject}`,
		html: marked.parse(text)
	}
}

async function parseEmail(message: ForwardableEmailMessage) {
	const rawEmail = await streamToArrayBuffer(message.raw, message.rawSize);
	const parser = new PostalMime();
	return await parser.parse(rawEmail);
}

async function handleNewEmail(message: ForwardableEmailMessage, email: Email, env: Env, ctx: ExecutionContext): Promise<void> {
	const qb = new D1QB(env.DB)

	console.log(`Received email from ${email.from.address}, with subject: ${email.subject}`)

	const todayEmails = await qb.select('emails')
		.where('from_address = ?', email.from.address)
		.where("DATE(created_at) = DATE('now')")
		.count()

	let modelResponse
	let rateLimited = false
	if (MAX_EMAILS_PER_DAY && todayEmails.results && todayEmails.results.total > MAX_EMAILS_PER_DAY) {
		rateLimited = true
		console.log(`Rate limited ${email.from.address} for today for using ${todayEmails.results.total} emails :/`)
		modelResponse = {
			response: `## You just reached today\'s limit for AskEmail :(
But don't worry, this will reset today at midnight UTC`,
			subject: 'You just reached today\'s limit for AskEmail :(',
			html: marked.parse(`## You just reached today\'s limit for AskEmail :(
But don't worry, this will reset today at midnight UTC`)
		}
	} else {
		console.log('No rate limit, starting inference')
		modelResponse = await generateResponse(email, env, qb)
	}

	const mailContent = mimemessage.factory({contentType: 'multipart/mixed', body: []});
	mailContent.header('In-Reply-To', message.headers.get("Message-ID"));
	mailContent.header('From', `AskEmail <${FROM_ADDRESS}>`);
	mailContent.header('To', message.from);
	mailContent.header('Subject', modelResponse.subject);

	if (message.headers.get("References")) {
		mailContent.header('References', message.headers.get("References"));
	}

	const body = `${modelResponse.html}



-----Original message-----
${(email.html ?? email.text)}`

	const alternateEntity = mimemessage.factory({
		contentType: 'multipart/alternate',
		body: [
			mimemessage.factory({
				contentType: 'text/html;charset=utf-8',
				body: body,
			})
		]
	});

	mailContent.body.push(alternateEntity);

	console.log(3)

	if (env.AWS_ACCESS_KEY && env.AWS_SECRET_KEY) {
		await sendViaSES(env, mailContent, message.from)
	} else {
		await sendViaWorkers(env, mailContent, message.from)
	}

	console.log(5)

	if (!rateLimited) {
		// Only from address is stored, to enforce the daily rate limit
		await qb.insert({
			tableName: 'emails',
			data: {
				from_address: email.from.address as string,
			}
		}).execute()
	}
}

async function sendViaWorkers(env: Env, mailContent: any, destination: string): Promise<void> {
	const message = new EmailMessage(
		FROM_ADDRESS,
		destination,
		mailContent.toString()
	);
	console.log(`Sending email to workers...`)
	await env.EMAIL.send(message);
}

async function sendViaSES(env: Env, mailContent: any, destination: string): Promise<void> {
	const client = new SESClient({
		region: 'eu-north-1',
		credentials: {
			accessKeyId: env.AWS_ACCESS_KEY,
			secretAccessKey: env.AWS_SECRET_KEY,
		},
	})

	const mail = new SendRawEmailCommand({
		Source: FROM_ADDRESS,
		Destinations: [destination],
		RawMessage: {Data: new TextEncoder().encode(mailContent.toString())}
	})

	console.log(`Sending email to AWS...`)
	await client.send(mail)
}
