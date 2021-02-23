'use strict'

import IORedis from 'ioredis'
import RedisRegistry, { DefaultClientInfo } from './index'
import { nanoid } from 'nanoid'

export interface MyClientInfo extends DefaultClientInfo {
  url?: string
}

const connection = new IORedis()
const registry = new RedisRegistry<MyClientInfo>({ connection })

// Create an ID
const id = nanoid()

// Create a client
registry.create(id, {
  url: '/socket'
}).then(info => {
  console.log(`created id ${id} with url ${info.url}`)
})

// Update a client
registry.update(id, {
  url: '/something-else'
}).then(info => {
  console.log(`updated id ${id} with url ${info.url}`)
})

// Delete a client
registry.delete(id).then(() => {
  console.log(`deleted id ${id}`)
})
