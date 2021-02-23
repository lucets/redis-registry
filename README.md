# @lucets/redis-registry

Redis registry for [@lucets/registry](https://github.com/lucets/registry).
Allows a decentralized application to send messages to peers on remote
instances using Redis Streams.

## Install

Install through npm:

```
npm i @lucets/redis-registry
```

## Example

See [@lucets/registry](https://github.com/lucets/registry) for more information.

```ts
import IORedis from 'ioredis'
import RedisRegistry from '@lucets/redis-registry'

const connection = new IORedis()
const registry = new RedisRegistry({ connection })

// Example: create a new client
await registry.create('id', {
  url: '/url'
})
```

## License

Copyright 2021 [Michiel van der Velde](https://michielvdvelde.nl).

This software is licensed under [the MIT License](LICENSE).
