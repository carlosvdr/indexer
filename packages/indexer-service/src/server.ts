import express, { response } from 'express'
import bodyParser from 'body-parser'
import morgan from 'morgan'
import { Stream } from 'stream'
import { logging, metrics } from '@graphprotocol/common-ts'
import { PaidQueryProcessor, FreeQueryProcessor } from './types'

export interface ServerOptions {
  logger: logging.Logger
  metrics: metrics.Metrics
  port: number
  paidQueryProcessor: PaidQueryProcessor
  freeQueryProcessor: FreeQueryProcessor
  whitelist: string[]
}

export const createServer = ({
  logger,
  metrics,
  port,
  paidQueryProcessor,
  freeQueryProcessor,
  whitelist,
}: ServerOptions) => {
  let loggerStream = new Stream.Writable()
  loggerStream._write = (chunk, _, next) => {
    logger.debug(chunk.toString().trim())
    next()
  }

  let server = express()

  // Log requests to the logger stream
  server.use(morgan('tiny', { stream: loggerStream }))

  // Accept JSON but don't parse it
  server.use(bodyParser.raw({ type: 'application/json' }))

  // Endpoint for health checks
  server.get('/', (_, res, __) => {
    res.status(200).send('Ready to roll!')
  })

  server.post('/subgraphs/id/:id', async (req, res, _) => {
    let { id: subgraphId } = req.params
    let query = req.body.toString()

    // Extract the payment ID
    let paymentId = req.headers['x-graph-payment-id']
    if (paymentId !== undefined && typeof paymentId !== 'string') {
      return res.status(400).send('Invalid X-Graph-Payment-Id provided')
    }

    // Trusted indexer scenario: if the source IP is in our whitelist,
    // we do not require payment; however, if there _is_ a payment,
    // we still take it
    let paymentRequired = true
    if (whitelist.indexOf(req.ip) >= 0) {
      paymentRequired = false
    }

    if (paymentRequired) {
      // Regular scenario: a payment is required; fail if no
      // payment ID is specified
      if (paymentId === undefined) {
        return res.status(400).send('No X-Graph-Payment-Id provided')
      }
    }

    if (paymentId !== undefined) {
      try {
        let response = await paidQueryProcessor.addPaidQuery({
          subgraphId,
          paymentId: paymentId as string,
          query,
        })
        res
          .status(response.status || 200)
          .contentType('application/json')
          .send(response.result)
      } catch (e) {
        logger.error(`Failed to handle paid query: ${e}`)
        res.status(500).send()
      }
    } else {
      try {
        let response = await freeQueryProcessor.addFreeQuery({
          subgraphId,
          query,
        })
        res
          .status(response.status || 200)
          .contentType('application/json')
          .send(response.data)
      } catch (e) {
        logger.error(`Failed to handle free query: ${e}`)
        res.status(500).send()
      }
    }
  })

  server.listen(port, () => {
    logger.debug(`Listening on port ${port}`)
  })

  return server
}
