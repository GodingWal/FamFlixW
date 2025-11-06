export const api = {
  get: async (url: string) => {
    const token = localStorage.getItem("token");
    const response = await fetch(url, {
      headers: {
        Authorization: token ? `Bearer ${token}` : "",
      },
      credentials: 'include',
      cache: 'no-store',
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Request failed");
    }
    
    return response.json();
  },

  post: async (url: string, data: any) => {
    const token = localStorage.getItem("token");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? `Bearer ${token}` : "",
      },
      body: JSON.stringify(data),
      credentials: 'include',
      cache: 'no-store',
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Request failed");
    }
    
    return response.json();
  },

  put: async (url: string, data: any) => {
    const token = localStorage.getItem("token");
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? `Bearer ${token}` : "",
      },
      body: JSON.stringify(data),
      credentials: 'include',
      cache: 'no-store',
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Request failed");
    }
    
    return response.json();
  },

  delete: async (url: string) => {
    const token = localStorage.getItem("token");
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: token ? `Bearer ${token}` : "",
      },
      credentials: 'include',
      cache: 'no-store',
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Request failed");
    }
    
    return response.json();
  },

  upload: async (url: string, formData: FormData) => {
    const token = localStorage.getItem("token");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: token ? `Bearer ${token}` : "",
      },
      body: formData,
      credentials: 'include',
      cache: 'no-store',
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Upload failed");
    }
    
    return response.json();
  },
};
