'use strict'

import WebSocket from 'ws'
import { Registry, DefaultClientInfo, DefaultMessage, RegistryError } from '@lucets/registry'
import { Redis } from 'ioredis'
import LRUCache, { Options as LRUOptions } from 'lru-cache'
import StreamManager, { StreamManagerOptions } from 'redis-streams-manager'

export interface Options<TClientInfo> {
  connection: Redis,
  existsCache?: LRUOptions<string, boolean>,
  clientCache?: LRUOptions<string, TClientInfo>,
  streams?: StreamManagerOptions
}

export function omit (obj: any, ...keys: string[]) {
  const newObj: any = {}

  Object.keys(obj).forEach(key => {
    if (keys.includes(key)) {
      newObj[key] = obj[key]
    }
  })

  return newObj
}

export { DefaultClientInfo, DefaultMessage } from '@lucets/registry'

export default class RedisRegistry<
  TClientInfo extends DefaultClientInfo = DefaultClientInfo,
  TMessage extends DefaultMessage = DefaultMessage
> implements Registry<TClientInfo> {
  #connection: Redis
  #streams: StreamManager
  #localClients: Map<string, TClientInfo> = new Map()
  #existsCache: LRUCache<string, boolean>
  #clientCache: LRUCache<string, TClientInfo>

  public constructor (options: Options<TClientInfo>) {
    this.#connection = options.connection
    this.#streams = new StreamManager(options.connection.duplicate(), options.streams)
    this.#existsCache = new LRUCache({
      max: 50,
      maxAge: 1000 * 60 * 5,
      ...(options.existsCache ?? {})
    })
    this.#clientCache = new LRUCache({
      max: 25,
      maxAge: 1000 * 60 * 5,
      ...(options.clientCache ?? {})
    })
  }

  public async info (id: string): Promise<TClientInfo> {
    let info = this.#localClients.get(id)

    if (info) {
      return omit(info, 'socket')
    }

    info = this.#clientCache.get(id)

    if (info) {
      return { ...info }
    }

    info = await this.#connection.hgetall(`clients:${id}`) as any as TClientInfo

    if (info) {
      info = this.deserialize(info)
      this.#clientCache.set(id, info)
      return { ...info }
    }
  }

  public async exists (id: string): Promise<boolean> {
    if (this.#localClients.has(id)) {
      return true
    }

    if (this.#clientCache.has(id)) {
      return true
    }

    if (this.#existsCache.has(id)) {
      return this.#existsCache.get(id)
    }

    const reply = await this.#connection.exists(`clients:${id}`)
    const exists = reply === 1 ? true : false
    this.#existsCache.set(id, exists)
    return exists
  }

  public async create (id: string, info?: Partial<TClientInfo>): Promise<TClientInfo> {
    if (await this.exists(id)) {
      throw new RegistryError('ID exists')
    }

    const fullInfo: TClientInfo = <any>{
      ...(info ?? {}),
      id,
      status: 'offline',
      createOn: new Date()
    }

    await this.#connection.multi()
      .rpush('clients', id)
      .hmset(`clients:${id}`, <any>this.serialize(fullInfo))
      .exec()

    this.#clientCache.set(id, fullInfo)
    return fullInfo
  }

  public async update (id: string, info: Partial<TClientInfo>): Promise<TClientInfo> {
    const fullInfo = await this.info(id)

    if (!fullInfo) {
      throw new RegistryError('ID not found')
    }

    const newInfo = {
      ...fullInfo,
      ...info
    }

    await this.#connection.hmset(`clients:${id}`, <any>this.serialize(newInfo))

    if (this.#localClients.has(id)) {
      const { socket } = this.#localClients.get(id)
      this.#localClients.set(id, { ...newInfo, socket })
    }

    return newInfo
  }

  public async delete (id: string): Promise<void> {
    const info = await this.info(id)

    if (!info) {
      throw new RegistryError('ID not found')
    } else if (info.status !== 'offline') {
      throw new RegistryError('ID not offline')
    }

    await this.#connection.multi()
      .lrem('clients', 1, id)
      .del(`clients:${id}`)
      .del(`clients:${id}:messages`)
      .exec()

    this.#existsCache.set(id, false)
    this.#clientCache.del(id)
  }

  public async register (id: string, socket: WebSocket): Promise<TClientInfo> {
    const info = await this.info(id)

    if (!info) {
      throw new RegistryError('ID not found')
    } else if (info.status !== 'offline') {
      throw new RegistryError('ID not offline')
    }

    info.status = 'online'
    info.socket = socket
    info.lastOnlineOn = new Date()

    // Update local clients
    this.#localClients.set(id, info)

    // Update client info in Redis
    await this.#connection.hmset(`clients:${id}`, <any>this.serialize(info))

    // Handle received message from the stream
    async function onMessage (message: Record<string, string>) {
      if (!info.socket || info.socket.readyState !== WebSocket.OPEN) {
        return
      }

      try {
        await new Promise<void>((resolve, reject) => {
          info.socket.send(JSON.stringify(message), err => {
            if (err) return reject(err)
            resolve
          })
        })
      } catch (e) {
        // Unable to send message
      }
    }

    // Add the message stream to the streams manager
    this.#streams.on(`clients:${id}:messages`, onMessage)

    info.socket.once('close', () => {
      // Remove the listener from the streams manager
      this.#streams.removeListener(`clients:${id}:messages`, onMessage)
    })

    return info
  }

  public async unregister (id: string): Promise<void> {
    const info = this.#localClients.get(id)

    if (!info) {
      throw new RegistryError('ID not local')
    }

    info.status = 'offline'
    info.lastOnlineOn = new Date()
    delete info.socket

    this.#localClients.delete(id)
    await this.#connection.hmset(`clients:${id}`, <any>this.serialize(info))
  }

  // @ts-ignore
  public async send (id: string, message: TMessage): Promise<void> {
    const info = await this.info(id)

    if (!info) {
      throw new RegistryError('ID not found')
    } else if (info.status !== 'online') {
      throw new RegistryError('ID not online')
    }

    if (info.socket) {
      // We have the socket locally
      if (info.socket.readyState !== WebSocket.OPEN) {
        throw new RegistryError('Socket not open')
      }

      return new Promise<void>((resolve, reject) => {
        info.socket.send(JSON.stringify(message), err => {
          if (err) return reject(err)
          resolve()
        })
      })
    }

    // Don't have the socket locally - add to client's message stream
    const flatMessage = Object.keys(message).flatMap(key => [ key, message[key] ])
    await this.#connection.xadd(`clients:${id}:messages`, '*', ...flatMessage)
  }

  /** Serialize client info for Redis. */
  private serialize (info: TClientInfo): TClientInfo {
    info = { ...info }

    if (info.createOn && info.createOn instanceof Date) {
      info.createOn = <any>info.createOn.toISOString()
    }

    if (info.lastOnlineOn && info.lastOnlineOn instanceof Date) {
      info.lastOnlineOn = <any>info.lastOnlineOn.toISOString()
    }

    if (info.socket) {
      delete info.socket
    }

    return info
  }

  /** Deserialize client info from Redis. */
  private deserialize (info: TClientInfo): TClientInfo {
    info = { ...info }

    if (info.createOn && typeof info.createOn === 'string') {
      info.createOn = new Date(info.createOn)
    }

    if (info.lastOnlineOn && typeof info.lastOnlineOn === 'string') {
      info.lastOnlineOn = new Date(info.lastOnlineOn)
    }

    return info
  }
}
