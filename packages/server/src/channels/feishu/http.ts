import { defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk'

/** Keep SDK decoding/stream handling while bounding API requests so the outbox can retry. */
export function feishuHttp(): HttpInstance {
  return Object.assign(Object.create(defaultHttpInstance) as HttpInstance, {
    request<T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> {
      // The SDK response interceptor already unwraps AxiosResponse to the API result.
      return defaultHttpInstance.request<T, R, D>({ ...options, timeout: options.timeout ?? 15_000 }) as Promise<R>
    },
  })
}
