import { useQuery, keepPreviousData } from "@tanstack/react-query";
export const API = "/api/v1";
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function request<T = any>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(!(options?.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options?.headers,
    },
  });
  if (!response.ok) {
    let message = `服务请求失败 (${response.status})`;
    try {
      const error = await response.json();
      message =
        typeof error.detail === "string"
          ? error.detail
          : error.detail?.message ||
            error.error?.message ||
            error.message ||
            JSON.stringify(error.detail || error);
    } catch {}
    throw new ApiError(message, response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export function post<T = any>(path: string, data: unknown) {
  return request<T>(path, { method: "POST", body: JSON.stringify(data) });
}
export function useApi<T = any>(path: string, enabled = true) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: ({ signal }) => request<T>(path, { signal }),
    enabled,
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: 20_000,
  });
}
export const idempotencyKey = () => crypto.randomUUID();
