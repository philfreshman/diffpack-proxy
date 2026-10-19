export default {
	fetch(): Response {
		return new Response("Hello from diffpack-proxy!\n", {
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	},
} satisfies ExportedHandler;
