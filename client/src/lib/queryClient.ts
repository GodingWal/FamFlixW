import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

// Enhanced error handling
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    let errorData: any;
    try {
      errorData = await res.json();
    } catch {
      errorData = { error: (await res.text()) || res.statusText };
    }

    throw new ApiError(
      res.status,
      errorData.error || errorData.message || 'Request failed',
      errorData.code,
      errorData
    );
  }
}

// Token refresh function
async function refreshTokens(): Promise<string | null> {
  try {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });

    if (response.ok) {
      const data = await response.json();
      if (data.accessToken) {
        // Update localStorage token for API requests
        localStorage.setItem('token', data.accessToken);
        // Update user data if provided
        if (data.user) {
          localStorage.setItem('user', JSON.stringify(data.user));
        }
        return data.accessToken;
      }
    } else {
      // If refresh fails, clear all auth data
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
  } catch (error) {
    console.error('Token refresh failed:', error);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }
  
  return null;
}

// Enhanced API request with automatic token refresh
export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  retryCount = 0
): Promise<Response> {
  const token = localStorage.getItem("token");
  const headers: Record<string, string> = {};
  
  if (data && !(data instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  
  // Always include Authorization header if we have a token
  // The server will use cookies as primary auth, but headers as fallback
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Add CSRF token for state-changing operations
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    if (csrfToken) {
      headers["X-CSRF-Token"] = csrfToken;
    }
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: data instanceof FormData ? data : (data ? JSON.stringify(data) : undefined),
      credentials: "include", // Always include cookies
      cache: "no-store", // Avoid conditional GET/304 and always hit the network
    });

    await throwIfResNotOk(res);
    return res;
  } catch (error) {
    // Handle authentication issues with an automatic refresh attempt
    if (error instanceof ApiError && retryCount === 0) {
      const shouldAttemptRefresh =
        error.code === 'TOKEN_EXPIRED' ||
        error.status === 401 || // e.g. "Access token required"
        (error.status === 403 && /Invalid token/i.test(error.message || ''));

      if (shouldAttemptRefresh) {
        console.log('[apiRequest] Auth error detected, attempting token refresh...');
        const newToken = await refreshTokens();
        if (newToken) {
          console.log('[apiRequest] Token refreshed, retrying original request.');
          return apiRequest(method, url, data, retryCount + 1);
        } else {
          console.log('[apiRequest] Token refresh failed, redirecting to login.');
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          window.location.href = '/login';
          throw error;
        }
      }
    }

    throw error;
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const token = localStorage.getItem("token");
    const headers: Record<string, string> = {};
    
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const url = queryKey.join("/") as string;
    const doFetch = async () =>
      fetch(url, {
        headers,
        credentials: "include",
        cache: "no-store", // Avoid conditional GET/304
      });

    let res = await doFetch();

    // If unauthorized or invalid token, attempt token refresh once
    if (res.status === 401 || res.status === 403) {
      let errorData: any = undefined;
      try {
        errorData = await res.clone().json();
      } catch {
        // ignore JSON parsing errors if body is empty
      }
      const message = String(errorData?.error || errorData?.message || "");
      const shouldRefresh =
        res.status === 401 || /invalid token/i.test(message) || errorData?.code === "TOKEN_EXPIRED";

      if (shouldRefresh) {
        const newToken = await refreshTokens();
        if (newToken) {
          headers["Authorization"] = `Bearer ${newToken}`;
          res = await doFetch();
        }
      }
    }

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null as any;
    }

    await throwIfResNotOk(res);
    return (await res.json()) as any;
  };

// Enhanced query client with better error handling and retry logic
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: (failureCount, error) => {
        // Don't retry on 4xx errors (client errors)
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        // Retry up to 3 times for network errors and 5xx errors
        return failureCount < 3;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    },
    mutations: {
      retry: (failureCount, error) => {
        // Don't retry mutations on 4xx errors
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        // Retry once for network errors
        return failureCount < 1;
      },
      onError: (error) => {
        // Global error handling for mutations
        if (error instanceof ApiError) {
          if (error.status === 401) {
            toast({
              title: "Authentication Required",
              description: "Please log in again to continue.",
              variant: "destructive",
            });
          } else if (error.status >= 500) {
            toast({
              title: "Server Error",
              description: "Something went wrong on our end. Please try again later.",
              variant: "destructive",
            });
          }
        } else {
          toast({
            title: "Network Error",
            description: "Please check your connection and try again.",
            variant: "destructive",
          });
        }
      },
    },
  },
});

// Export ApiError for use in components
export { ApiError };
