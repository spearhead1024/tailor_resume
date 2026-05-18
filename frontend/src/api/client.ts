import axios, { AxiosRequestConfig } from 'axios';
import { getToken } from '../lib/auth';

const axiosInstance = axios.create({
  baseURL: '',
  timeout: 120_000,
});

axiosInstance.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

async function request<T>(method: string, url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const res = await axiosInstance.request<T>({ method, url, data, ...(config || {}) });
  return res.data;
}

export const api = {
  get: <T>(url: string, config?: AxiosRequestConfig) => request<T>('get', url, undefined, config),
  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => request<T>('post', url, data, config),
  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => request<T>('put', url, data, config),
  patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => request<T>('patch', url, data, config),
  delete: <T>(url: string, config?: AxiosRequestConfig) => request<T>('delete', url, undefined, config),
  raw: axiosInstance,
};
