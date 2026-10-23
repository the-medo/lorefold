export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error ?? body.message ?? "The request failed. Please try again.",
    );
  return body as T;
}
