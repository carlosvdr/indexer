/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  Eventual,
  join,
  Logger,
  Metrics,
  SubgraphDeploymentID,
  timer,
} from '@graphprotocol/common-ts'
import {
  Allocation,
  AllocationManagementMode,
  allocationRewardsPool,
  AllocationStatus,
  indexerError,
  IndexerErrorCode,
  IndexingDecisionBasis,
  IndexerManagementClient,
  IndexingRuleAttributes,
  Network,
  POIDisputeAttributes,
  RewardsPool,
  Subgraph,
  SubgraphDeployment,
  SubgraphIdentifierType,
  evaluateDeployments,
  AllocationDecision,
  GraphNode,
  Operator,
  validateProviderNetworkIdentifier,
  MultiNetworks,
  NetworkMapped,
} from '@graphprotocol/indexer-common'

import PQueue from 'p-queue'
import pMap from 'p-map'
import pFilter from 'p-filter'
import isEqual from 'lodash.isequal'
import mapValues from 'lodash.mapvalues'
import isEmpty from 'lodash.isempty'
import zip from 'lodash.zip'

type ActionReconciliationContext = [
  AllocationDecision[],
  Allocation[],
  number,
  number,
]

const deploymentInList = (
  list: SubgraphDeploymentID[],
  deployment: SubgraphDeploymentID,
): boolean =>
  list.find(item => item.bytes32 === deployment.bytes32) !== undefined

const deploymentRuleInList = (
  list: IndexingRuleAttributes[],
  deployment: SubgraphDeploymentID,
): boolean =>
  list.find(
    rule =>
      rule.identifierType == SubgraphIdentifierType.DEPLOYMENT &&
      new SubgraphDeploymentID(rule.identifier).toString() ==
        deployment.toString(),
  ) !== undefined

const uniqueDeploymentsOnly = (
  value: SubgraphDeploymentID,
  index: number,
  array: SubgraphDeploymentID[],
): boolean => array.findIndex(v => value.bytes32 === v.bytes32) === index

const uniqueDeployments = (
  deployments: SubgraphDeploymentID[],
): SubgraphDeploymentID[] => deployments.filter(uniqueDeploymentsOnly)

export const convertSubgraphBasedRulesToDeploymentBased = (
  rules: IndexingRuleAttributes[],
  subgraphs: Subgraph[],
  previousVersionBuffer: number,
): IndexingRuleAttributes[] => {
  const toAdd: IndexingRuleAttributes[] = []
  rules.map(rule => {
    if (rule.identifierType !== SubgraphIdentifierType.SUBGRAPH) {
      return rule
    }
    const ruleSubgraph = subgraphs.find(
      subgraph => subgraph.id == rule.identifier,
    )
    if (ruleSubgraph) {
      const latestVersion = ruleSubgraph.versionCount - 1
      const latestDeploymentVersion = ruleSubgraph.versions.find(
        version => version.version == latestVersion,
      )
      if (latestDeploymentVersion) {
        if (!deploymentRuleInList(rules, latestDeploymentVersion!.deployment)) {
          rule.identifier = latestDeploymentVersion!.deployment.toString()
          rule.identifierType = SubgraphIdentifierType.DEPLOYMENT
        }

        const currentTimestamp = Math.floor(Date.now() / 1000)
        if (
          latestDeploymentVersion.createdAt >
          currentTimestamp - previousVersionBuffer
        ) {
          const previousDeploymentVersion = ruleSubgraph.versions.find(
            version => version.version == latestVersion - 1,
          )
          if (
            previousDeploymentVersion &&
            !deploymentRuleInList(rules, previousDeploymentVersion.deployment)
          ) {
            const previousDeploymentRule = { ...rule }
            previousDeploymentRule.identifier =
              previousDeploymentVersion!.deployment.toString()
            previousDeploymentRule.identifierType =
              SubgraphIdentifierType.DEPLOYMENT
            toAdd.push(previousDeploymentRule)
          }
        }
      }
    }
    return rule
  })
  rules.push(...toAdd)
  return rules
}

const deploymentIDSet = (deployments: SubgraphDeploymentID[]): Set<string> =>
  new Set(deployments.map(id => id.bytes32))

// Represents a pair of Network and Operator instances belonging to the same protocol
// network. Used when mapping over multiple protocol networks.
type NetworkAndOperator = {
  network: Network
  operator: Operator
}

// Extracts the network identifier from a pair of matching Network and Operator objects.
function networkAndOperatorIdentity({
  network,
  operator,
}: NetworkAndOperator): string {
  const networkId = network.specification.networkIdentifier
  const operatorId = operator.specification.networkIdentifier
  if (networkId !== operatorId) {
    throw new Error(
      `Network and Operator pairs have different network identifiers: ${networkId} != ${operatorId}`,
    )
  }
  return networkId
}

// Helper function to produce a `MultiNetworks<NetworkAndOperator>` while validating its
// inputs.
function createMultiNetworks(
  networks: Network[],
  operators: Operator[],
): MultiNetworks<NetworkAndOperator> {
  // Check if inputs have uneven lenghts and if they have the same network identifiers
  const validInputs =
    networks.length === operators.length &&
    networks.every(
      (network, index) =>
        network.specification.networkIdentifier ===
        operators[index].specification.networkIdentifier,
    )
  if (!validInputs) {
    throw new Error(
      'Invalid Networks and Operator pairs used in Agent initialization',
    )
  }
  // Note on undefineds: `lodash.zip` can return `undefined` if array lengths are
  // uneven, but we have just checked that.
  const networksAndOperators = zip(networks, operators).map(pair => {
    const [network, operator] = pair
    return { network: network!, operator: operator! }
  })
  return new MultiNetworks(networksAndOperators, networkAndOperatorIdentity)
}

export class Agent {
  logger: Logger
  metrics: Metrics
  graphNode: GraphNode
  multiNetworks: MultiNetworks<NetworkAndOperator>
  indexerManagement: IndexerManagementClient
  offchainSubgraphs: SubgraphDeploymentID[]

  constructor(
    logger: Logger,
    metrics: Metrics,
    graphNode: GraphNode,
    operators: Operator[],
    indexerManagement: IndexerManagementClient,
    networks: Network[],
    offchainSubgraphs: SubgraphDeploymentID[],
  ) {
    this.logger = logger.child({ component: 'Agent' })
    this.metrics = metrics
    this.graphNode = graphNode
    this.indexerManagement = indexerManagement
    this.multiNetworks = createMultiNetworks(networks, operators)
    this.offchainSubgraphs = offchainSubgraphs
  }

  async start(): Promise<Agent> {
    // --------------------------------------------------------------------------------
    // * Connect to Graph Node
    // --------------------------------------------------------------------------------
    this.logger.info(`Connect to Graph node(s)`)
    await this.graphNode.connect()
    this.logger.info(`Connected to Graph node(s)`)

    // --------------------------------------------------------------------------------
    // * Ensure there is a 'global' indexing rule
    // --------------------------------------------------------------------------------
    await this.multiNetworks.map(({ operator }) =>
      operator.ensureGlobalIndexingRule(),
    )

    // --------------------------------------------------------------------------------
    // * Ensure NetworkSubgraph is indexing
    // --------------------------------------------------------------------------------
    await this.multiNetworks.map(async ({ network }) =>
      this.ensureNetworkSubgraphIsIndexing(network),
    )

    // --------------------------------------------------------------------------------
    // * Register the Indexer in the Network
    // --------------------------------------------------------------------------------
    await this.multiNetworks.map(({ network }) => network.register())

    this.buildEventualTree()
    return this
  }

  buildEventualTree() {
    const currentEpochNumber: Eventual<NetworkMapped<number>> = timer(
      600_000,
    ).tryMap(
      async () =>
        await this.multiNetworks.map(({ network }) =>
          network.networkMonitor.currentEpochNumber(),
        ),
      {
        onError: error =>
          this.logger.warn(`Failed to fetch current epoch`, { error }),
      },
    )

    const channelDisputeEpochs: Eventual<NetworkMapped<number>> = timer(
      600_000,
    ).tryMap(
      () =>
        this.multiNetworks.map(({ network }) =>
          network.contracts.staking.channelDisputeEpochs(),
        ),
      {
        onError: error =>
          this.logger.warn(`Failed to fetch channel dispute epochs`, { error }),
      },
    )

    const maxAllocationEpochs: Eventual<NetworkMapped<number>> = timer(
      600_000,
    ).tryMap(
      () =>
        this.multiNetworks.map(({ network }) =>
          network.contracts.staking.maxAllocationEpochs(),
        ),
      {
        onError: error =>
          this.logger.warn(`Failed to fetch max allocation epochs`, { error }),
      },
    )

    const indexingRules: Eventual<NetworkMapped<IndexingRuleAttributes[]>> =
      timer(20_000).tryMap(
        async () => {
          return this.multiNetworks.map(async ({ network, operator }) => {
            let rules = await operator.indexingRules(true)
            const subgraphRuleIds = rules
              .filter(
                rule => rule.identifierType == SubgraphIdentifierType.SUBGRAPH,
              )
              .map(rule => rule.identifier!)
            const subgraphsMatchingRules =
              await network.networkMonitor.subgraphs(subgraphRuleIds)
            if (subgraphsMatchingRules.length >= 1) {
              const epochLength =
                await network.contracts.epochManager.epochLength()
              const blockPeriod = 15
              const bufferPeriod = epochLength.toNumber() * blockPeriod * 100 // 100 epochs
              rules = convertSubgraphBasedRulesToDeploymentBased(
                rules,
                subgraphsMatchingRules,
                bufferPeriod,
              )
            }
            return rules
          })
        },
        {
          onError: error =>
            this.logger.warn(
              `Failed to obtain indexing rules, trying again later`,
              { error },
            ),
        },
      )

    const activeDeployments: Eventual<SubgraphDeploymentID[]> = timer(
      60_000,
    ).tryMap(() => this.graphNode.subgraphDeployments(), {
      onError: error =>
        this.logger.warn(
          `Failed to obtain active deployments, trying again later`,
          {
            error,
          },
        ),
    })

    const networkDeployments: Eventual<NetworkMapped<SubgraphDeployment[]>> =
      timer(240_000).tryMap(
        async () =>
          await this.multiNetworks.map(({ network }) =>
            network.networkMonitor.subgraphDeployments(),
          ),
        {
          onError: error =>
            this.logger.warn(
              `Failed to obtain network deployments, trying again later`,
              {
                error,
              },
            ),
        },
      )

    const networkDeploymentAllocationDecisions: Eventual<
      NetworkMapped<AllocationDecision[]>
    > = join({
      networkDeployments,
      indexingRules,
    }).tryMap(
      ({ indexingRules, networkDeployments }) => {
        const rulesAndDeploymentsByNetwork = this.multiNetworks.zip(
          indexingRules,
          networkDeployments,
        )
        return mapValues(
          rulesAndDeploymentsByNetwork,
          ([indexingRules, networkDeployments]: [
            IndexingRuleAttributes[],
            SubgraphDeployment[],
          ]) => {
            // Identify subgraph deployments on the network that are worth picking up;
            // these may overlap with the ones we're already indexing
            return indexingRules.length === 0
              ? []
              : evaluateDeployments(
                  this.logger,
                  networkDeployments,
                  indexingRules,
                )
          },
        )
      },
      {
        onError: error =>
          this.logger.warn(
            `Failed to obtain target allocations, trying again later`,
            {
              error,
            },
          ),
      },
    )

    // let targetDeployments be an union of targetAllocations
    // and offchain subgraphs.
    const targetDeployments: Eventual<SubgraphDeploymentID[]> = join({
      ticker: timer(120_000),
      indexingRules,
      networkDeploymentAllocationDecisions,
    }).tryMap(
      async ({ indexingRules, networkDeploymentAllocationDecisions }) => {
        const targetDeploymentIDs: Set<SubgraphDeploymentID> = new Set(
          // Concatenate all AllocationDecisions from all protocol networks
          Object.values(networkDeploymentAllocationDecisions)
            .flat()
            .filter(decision => decision.toAllocate === true)
            .map(decision => decision.deployment),
        )

        // Add offchain subgraphs to the deployment list from rules
        Object.values(indexingRules)
          .flat()
          .filter(
            rule => rule?.decisionBasis === IndexingDecisionBasis.OFFCHAIN,
          )
          .forEach(rule => {
            targetDeploymentIDs.add(new SubgraphDeploymentID(rule.identifier))
          })
        // From startup args
        this.offchainSubgraphs.forEach(deployment => {
          targetDeploymentIDs.add(deployment)
        })
        return [...targetDeploymentIDs]
      },
      {
        onError: error =>
          this.logger.warn(
            `Failed to obtain target deployments, trying again later`,
            {
              error,
            },
          ),
      },
    )

    const activeAllocations: Eventual<NetworkMapped<Allocation[]>> = timer(
      120_000,
    ).tryMap(
      () =>
        this.multiNetworks.map(({ network }) =>
          network.networkMonitor.allocations(AllocationStatus.ACTIVE),
        ),
      {
        onError: () =>
          this.logger.warn(
            `Failed to obtain active allocations, trying again later`,
          ),
      },
    )

    // `activeAllocations` is used to trigger this Eventual, but not really needed
    // inside.
    const recentlyClosedAllocations: Eventual<Allocation[]> = join({
      activeAllocations,
      currentEpochNumber,
    }).tryMap(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async ({ activeAllocations: _, currentEpochNumber }) => {
        const allocationsByNetwork = await this.multiNetworks.mapNetworkMapped(
          currentEpochNumber,
          async ({ network }, epochNumber): Promise<Allocation[]> => {
            return await network.networkMonitor.recentlyClosedAllocations(
              epochNumber,
              1,
            )
          },
        )
        return Object.values(allocationsByNetwork).flat()
      },
      {
        onError: () =>
          this.logger.warn(
            `Failed to obtain active allocations, trying again later`,
          ),
      },
    )

    const claimableAllocations: Eventual<NetworkMapped<Allocation[]>> = join({
      currentEpochNumber,
      channelDisputeEpochs,
    }).tryMap(
      async ({ currentEpochNumber, channelDisputeEpochs }) => {
        const zipped = this.multiNetworks.zip(
          currentEpochNumber,
          channelDisputeEpochs,
        )

        const mapper = async (
          { network }: NetworkAndOperator,
          [currentEpochNumber, channelDisputeEpochs]: [number, number],
        ): Promise<Allocation[]> =>
          network.networkMonitor.claimableAllocations(
            currentEpochNumber - channelDisputeEpochs,
          )

        return this.multiNetworks.mapNetworkMapped(zipped, mapper)
      },

      {
        onError: () =>
          this.logger.warn(
            `Failed to obtain claimable allocations, trying again later`,
          ),
      },
    )

    // TODO: this log line seems out of place
    this.logger.info(`Waiting for network data before reconciling every 120s`)

    const disputableAllocations: Eventual<NetworkMapped<Allocation[]>> = join({
      currentEpochNumber,
      activeDeployments,
    }).tryMap(
      async ({ currentEpochNumber, activeDeployments }) =>
        this.multiNetworks.mapNetworkMapped(
          currentEpochNumber,
          ({ network }: NetworkAndOperator, currentEpochNumber: number) =>
            network.networkMonitor.disputableAllocations(
              currentEpochNumber,
              activeDeployments,
              0,
            ),
        ),

      {
        onError: () =>
          this.logger.warn(
            `Failed to fetch disputable allocations, trying again later`,
          ),
      },
    )

    join({
      ticker: timer(240_000),
      currentEpochNumber,
      maxAllocationEpochs,
      activeDeployments,
      targetDeployments,
      activeAllocations,
      networkDeploymentAllocationDecisions,
      recentlyClosedAllocations,
      claimableAllocations,
      disputableAllocations,
    }).pipe(
      async ({
        currentEpochNumber,
        maxAllocationEpochs,
        activeDeployments,
        targetDeployments,
        activeAllocations,
        networkDeploymentAllocationDecisions,
        recentlyClosedAllocations,
        claimableAllocations,
        disputableAllocations,
      }) => {
        this.logger.info(`Reconcile with the network`, {
          currentEpochNumber,
        })

        // Claim rebate pool rewards from finalized allocations
        await this.multiNetworks.mapNetworkMapped(
          claimableAllocations,
          ({ network }: NetworkAndOperator, allocations: Allocation[]) =>
            network.claimRebateRewards(allocations),
        )

        try {
          const disputableEpochs = await this.multiNetworks.mapNetworkMapped(
            currentEpochNumber,
            async (
              { network }: NetworkAndOperator,
              currentEpochNumber: number,
            ) =>
              currentEpochNumber -
              network.specification.indexerOptions.poiDisputableEpochs,
          )

          // Find disputable allocations
          const zipped = this.multiNetworks.zip(
            disputableEpochs,
            disputableAllocations,
          )
          const mapper = async (
            { network, operator }: NetworkAndOperator,
            [disputableEpoch, disputableAllocations]: [number, Allocation[]],
          ): Promise<void> => {
            await this.identifyPotentialDisputes(
              disputableAllocations,
              disputableEpoch,
              operator,
              network,
            )
          }
          await this.multiNetworks.mapNetworkMapped(zipped, mapper)
        } catch (err) {
          this.logger.warn(`Failed POI dispute monitoring`, { err })
        }

        const eligibleAllocations: Allocation[] = [
          ...recentlyClosedAllocations,
          ...Object.values(activeAllocations).flat(),
        ]

        try {
          // Reconcile deployments
          await this.reconcileDeployments(
            activeDeployments,
            targetDeployments,
            eligibleAllocations,
          )
        } catch (err) {
          this.logger.warn(
            `Exited early while reconciling deployments. Skipped reconciling actions.`,
            {
              err: indexerError(IndexerErrorCode.IE005, err),
            },
          )
          return
        }
        try {
          // Reconcile allocation actions
          await this.reconcileActions(
            networkDeploymentAllocationDecisions,
            activeAllocations,
            currentEpochNumber,
            maxAllocationEpochs,
          )
        } catch (err) {
          this.logger.warn(`Exited early while reconciling actions`, {
            err: indexerError(IndexerErrorCode.IE005, err),
          })
          return
        }
      },
    )
  }

  // TODO:L2: Perform this procedure for all configured networks, not just one
  async identifyPotentialDisputes(
    disputableAllocations: Allocation[],
    disputableEpoch: number,
    operator: Operator,
    network: Network,
  ): Promise<void> {
    // TODO: Support supplying status = 'any' to fetchPOIDisputes() to fetch all previously processed allocations in a single query

    const alreadyProcessed = (
      await operator.fetchPOIDisputes(
        'potential',
        disputableEpoch,
        operator.specification.networkIdentifier,
      )
    ).concat(
      await operator.fetchPOIDisputes(
        'valid',
        disputableEpoch,
        operator.specification.networkIdentifier,
      ),
    )

    const newDisputableAllocations = disputableAllocations.filter(
      allocation =>
        !alreadyProcessed.find(
          dispute => dispute.allocationID == allocation.id,
        ),
    )
    if (newDisputableAllocations.length == 0) {
      this.logger.trace(
        'No new disputable allocations to process for potential disputes',
      )
      return
    }

    this.logger.debug(
      `Found new allocations onchain for subgraphs we have indexed. Let's compare POIs to identify any potential indexing disputes`,
    )

    const uniqueRewardsPools: RewardsPool[] = await Promise.all(
      [
        ...new Set(
          newDisputableAllocations.map(allocation =>
            allocationRewardsPool(allocation),
          ),
        ),
      ]
        .filter(pool => pool.closedAtEpochStartBlockHash)
        .map(async pool => {
          const closedAtEpochStartBlock =
            await network.networkProvider.getBlock(
              pool.closedAtEpochStartBlockHash!,
            )

          // Todo: Lazily fetch this, only if the first reference POI doesn't match
          const previousEpochStartBlock =
            await network.networkProvider.getBlock(
              pool.previousEpochStartBlockHash!,
            )
          pool.closedAtEpochStartBlockNumber = closedAtEpochStartBlock.number
          pool.referencePOI = await this.graphNode.proofOfIndexing(
            pool.subgraphDeployment,
            {
              number: closedAtEpochStartBlock.number,
              hash: closedAtEpochStartBlock.hash,
            },
            pool.allocationIndexer,
          )
          pool.previousEpochStartBlockHash = previousEpochStartBlock.hash
          pool.previousEpochStartBlockNumber = previousEpochStartBlock.number
          pool.referencePreviousPOI = await this.graphNode.proofOfIndexing(
            pool.subgraphDeployment,
            {
              number: previousEpochStartBlock.number,
              hash: previousEpochStartBlock.hash,
            },
            pool.allocationIndexer,
          )
          return pool
        }),
    )

    const disputes: POIDisputeAttributes[] = newDisputableAllocations.map(
      (allocation: Allocation) => {
        const rewardsPool = uniqueRewardsPools.find(
          pool =>
            pool.subgraphDeployment == allocation.subgraphDeployment.id &&
            pool.closedAtEpoch == allocation.closedAtEpoch,
        )
        if (!rewardsPool) {
          throw Error(
            `No rewards pool found for deployment ${allocation.subgraphDeployment.id}`,
          )
        }

        let status =
          rewardsPool!.referencePOI == allocation.poi ||
          rewardsPool!.referencePreviousPOI == allocation.poi
            ? 'valid'
            : 'potential'

        if (
          status === 'potential' &&
          (!rewardsPool.referencePOI || !rewardsPool.referencePreviousPOI)
        ) {
          status = 'reference_unavailable'
        }

        return {
          allocationID: allocation.id,
          subgraphDeploymentID: allocation.subgraphDeployment.id.ipfsHash,
          allocationIndexer: allocation.indexer,
          allocationAmount: allocation.allocatedTokens.toString(),
          allocationProof: allocation.poi!,
          closedEpoch: allocation.closedAtEpoch,
          closedEpochReferenceProof: rewardsPool!.referencePOI,
          closedEpochStartBlockHash: allocation.closedAtEpochStartBlockHash!,
          closedEpochStartBlockNumber:
            rewardsPool!.closedAtEpochStartBlockNumber!,
          previousEpochReferenceProof: rewardsPool!.referencePreviousPOI,
          previousEpochStartBlockHash:
            rewardsPool!.previousEpochStartBlockHash!,
          previousEpochStartBlockNumber:
            rewardsPool!.previousEpochStartBlockNumber!,
          status,
          protocolNetwork: network.specification.networkIdentifier,
        } as POIDisputeAttributes
      },
    )

    const potentialDisputes = disputes.filter(
      dispute => dispute.status == 'potential',
    ).length
    const stored = await operator.storePoiDisputes(disputes)

    this.logger.info(`Disputable allocations' POIs validated`, {
      potentialDisputes: potentialDisputes,
      validAllocations: stored.length - potentialDisputes,
    })
  }

  // This function assumes that allocations and deployments passed to it have already
  // been retrieved from multiple networks.
  async reconcileDeployments(
    activeDeployments: SubgraphDeploymentID[],
    targetDeployments: SubgraphDeploymentID[],
    eligibleAllocations: Allocation[],
  ): Promise<void> {
    // ----------------------------------------------------------------------------------------
    // Ensure the network subgraph deployment is _always_ indexed
    // ----------------------------------------------------------------------------------------
    this.multiNetworks.map(async ({ network }) => {
      if (network.networkSubgraph.deployment) {
        const networkDeploymentID = network.networkSubgraph.deployment.id
        if (!deploymentInList(targetDeployments, networkDeploymentID)) {
          targetDeployments.push(networkDeploymentID)
        }
      }
    })

    // ----------------------------------------------------------------------------------------
    // Inspect Deployments and Networks
    // ----------------------------------------------------------------------------------------
    // Ensure all subgraphs in offchain subgraphs list are _always_ indexed
    for (const offchainSubgraph of this.offchainSubgraphs) {
      if (!deploymentInList(targetDeployments, offchainSubgraph)) {
        targetDeployments.push(offchainSubgraph)
      }
    }
    activeDeployments = uniqueDeployments(activeDeployments)
    targetDeployments = uniqueDeployments(targetDeployments)

    // Note eligibleAllocations are active or recently closed allocations still eligible
    // for queries from the gateway
    const eligibleAllocationDeployments = uniqueDeployments(
      eligibleAllocations.map(allocation => allocation.subgraphDeployment.id),
    )

    // Log details if active deployments are different from target deployments
    const isReconciliationNeeded = !isEqual(
      deploymentIDSet(activeDeployments),
      deploymentIDSet(targetDeployments),
    )
    if (isReconciliationNeeded) {
      // QUESTION: should we return early in here case reconciliation is not needed?
      this.logger.debug('Reconcile deployments', {
        syncing: activeDeployments.map(id => id.display),
        target: targetDeployments.map(id => id.display),
        withActiveOrRecentlyClosedAllocation: eligibleAllocationDeployments.map(
          id => id.display,
        ),
      })
    }

    // Identify which subgraphs to deploy and which to remove
    const deploy = targetDeployments.filter(
      deployment => !deploymentInList(activeDeployments, deployment),
    )
    const remove = activeDeployments.filter(
      deployment =>
        !deploymentInList(targetDeployments, deployment) &&
        !deploymentInList(eligibleAllocationDeployments, deployment),
    )

    // QUESTION: Same as before: should we return early in here case reconciliation is
    // not needed?
    if (deploy.length + remove.length !== 0) {
      this.logger.info('Deployment changes', {
        deploy: deploy.map(id => id.display),
        remove: remove.map(id => id.display),
      })
    }

    // ----------------------------------------------------------------------------------------
    // Execute Deployments (Add, Remove)
    // ----------------------------------------------------------------------------------------

    // Deploy/remove up to 10 subgraphs in parallel
    const queue = new PQueue({ concurrency: 10 })

    // Index all new deployments worth indexing
    await queue.addAll(
      deploy.map(deployment => async () => {
        const name = `indexer-agent/${deployment.ipfsHash.slice(-10)}`

        this.logger.info(`Index subgraph deployment`, {
          name,
          deployment: deployment.display,
        })

        // Ensure the deployment is deployed to the indexer
        // Note: we're not waiting here, as sometimes indexing a subgraph
        // will block if the IPFS files cannot be retrieved
        this.graphNode.ensure(name, deployment)
      }),
    )

    // Stop indexing deployments that are no longer worth indexing
    await queue.addAll(
      remove.map(deployment => async () => this.graphNode.remove(deployment)),
    )

    await queue.onIdle()
  }

  async identifyExpiringAllocations(
    _logger: Logger,
    activeAllocations: Allocation[],
    deploymentAllocationDecision: AllocationDecision,
    epoch: number,
    maxAllocationEpochs: number,
    network: Network,
  ): Promise<Allocation[]> {
    const desiredAllocationLifetime = deploymentAllocationDecision.ruleMatch
      .rule?.allocationLifetime
      ? deploymentAllocationDecision.ruleMatch.rule.allocationLifetime
      : Math.max(1, maxAllocationEpochs - 1)

    // Identify expiring allocations
    let expiredAllocations = activeAllocations.filter(
      allocation =>
        epoch >= allocation.createdAtEpoch + desiredAllocationLifetime,
    )
    // The allocations come from the network subgraph; due to short indexing
    // latencies, this data may be slightly outdated. Cross-check with the
    // contracts to avoid closing allocations that are already closed on
    // chain.
    expiredAllocations = await pFilter(
      expiredAllocations,
      async (allocation: Allocation) => {
        try {
          const onChainAllocation =
            await network.contracts.staking.getAllocation(allocation.id)
          return onChainAllocation.closedAtEpoch.eq('0')
        } catch (err) {
          this.logger.warn(
            `Failed to cross-check allocation state with contracts; assuming it needs to be closed`,
            {
              deployment: deploymentAllocationDecision.deployment.ipfsHash,
              allocation: allocation.id,
              err: indexerError(IndexerErrorCode.IE006, err),
            },
          )
          return true
        }
      },
    )
    return expiredAllocations
  }

  async reconcileDeploymentAllocationAction(
    deploymentAllocationDecision: AllocationDecision,
    epoch: number,
    maxAllocationEpochs: number,
    network: Network,
    operator: Operator,
  ): Promise<void> {
    const logger = this.logger.child({
      deployment: deploymentAllocationDecision.deployment.ipfsHash,
      protocolNetwork: network.specification.networkIdentifier,
      epoch,
    })

    // Accuracy check: re-fetch allocations to ensure that we have a fresh state since
    // the start of the reconciliation loop
    const activeAllocations: Allocation[] =
      await network.networkMonitor.allocations(AllocationStatus.ACTIVE)

    // QUESTION: Can we replace `filter` for `find` here? Is there such a case when we
    // would have multiple allocations for the same subgraph?
    const activeDeploymentAllocations = activeAllocations.filter(
      allocation =>
        allocation.subgraphDeployment.id.bytes32 ===
        deploymentAllocationDecision.deployment.bytes32,
    )

    switch (deploymentAllocationDecision.toAllocate) {
      case false:
        return await operator.closeEligibleAllocations(
          logger,
          deploymentAllocationDecision,
          activeDeploymentAllocations,
          epoch,
        )
      case true: {
        // If no active allocations, create one
        if (activeDeploymentAllocations.length === 0) {
          // Fetch the latest closed allocation, if any
          const mostRecentlyClosedAllocation = (
            await network.networkMonitor.closedAllocations(
              deploymentAllocationDecision.deployment,
            )
          )[0]
          return await operator.createAllocation(
            logger,
            deploymentAllocationDecision,
            mostRecentlyClosedAllocation,
          )
        }

        // Refresh any expiring allocations
        const expiringAllocations = await this.identifyExpiringAllocations(
          logger,
          activeDeploymentAllocations,
          deploymentAllocationDecision,
          epoch,
          maxAllocationEpochs,
          network,
        )
        if (expiringAllocations.length > 0) {
          await operator.refreshExpiredAllocations(
            logger,
            deploymentAllocationDecision,
            expiringAllocations,
          )
        }
      }
    }
  }

  // QUESTION: the `activeAllocations` parameter is used only for logging. Should we
  // remove it from this function?
  async reconcileActions(
    networkDeploymentAllocationDecisions: NetworkMapped<AllocationDecision[]>,
    activeAllocations: NetworkMapped<Allocation[]>,
    epoch: NetworkMapped<number>,
    maxAllocationEpochs: NetworkMapped<number>,
  ): Promise<void> {
    // ----------------------------------------------------------------------------------------
    // Filter out networks set to `manual` allocation management mode
    // ----------------------------------------------------------------------------------------
    const manualModeNetworks = this.multiNetworks.mapNetworkMapped(
      networkDeploymentAllocationDecisions,
      async ({ network }) =>
        network.specification.indexerOptions.allocationManagementMode ==
        AllocationManagementMode.MANUAL,
    )

    for (const [networkIdentifier, isOnManualMode] of Object.entries(
      manualModeNetworks,
    )) {
      if (isOnManualMode) {
        const allocationDecisions =
          networkDeploymentAllocationDecisions[networkIdentifier]
        this.logger.trace(
          `Skipping allocation reconciliation since AllocationManagementMode = 'manual'`,
          {
            protocolNetwork: networkIdentifier,
            activeAllocations,
            targetDeployments: allocationDecisions
              .filter(decision => decision.toAllocate)
              .map(decision => decision.deployment.ipfsHash),
          },
        )
        delete networkDeploymentAllocationDecisions[networkIdentifier]
      }
    }

    if (isEmpty(networkDeploymentAllocationDecisions)) {
      return
    }

    // ----------------------------------------------------------------------------------------
    // Ensure the network subgraph is NEVER allocated towards
    // ----------------------------------------------------------------------------------------

    const filteredNetworkDeploymentAllocationDecisions =
      await this.multiNetworks.mapNetworkMapped(
        networkDeploymentAllocationDecisions,
        async (
          { network }: NetworkAndOperator,
          allocationDecisions: AllocationDecision[],
        ) => {
          const networkSubgraphDeployment = network.networkSubgraph.deployment
          if (
            networkSubgraphDeployment &&
            !network.specification.indexerOptions.allocateOnNetworkSubgraph
          ) {
            // QUESTION: Could we just remove this allocation decision from the set?
            const networkSubgraphIndex = allocationDecisions.findIndex(
              decision =>
                decision.deployment.bytes32 ==
                networkSubgraphDeployment.id.bytes32,
            )
            if (networkSubgraphIndex >= 0) {
              allocationDecisions[networkSubgraphIndex].toAllocate = false
            }
          }
          return allocationDecisions
        },
      )

    //----------------------------------------------------------------------------------------
    // For every network, loop through all deployments and queue allocation actions if needed
    //----------------------------------------------------------------------------------------
    await this.multiNetworks.mapNetworkMapped(
      this.multiNetworks.zip4(
        filteredNetworkDeploymentAllocationDecisions,
        activeAllocations,
        epoch,
        maxAllocationEpochs,
      ),
      async (
        { network, operator }: NetworkAndOperator,
        [
          allocationDecisions,
          activeAllocations,
          epoch,
          maxAllocationEpochs,
        ]: ActionReconciliationContext,
      ) => {
        this.logger.trace(`Reconcile allocation actions`, {
          protocolNetwork: network.specification.networkIdentifier,
          epoch,
          maxAllocationEpochs,
          targetDeployments: allocationDecisions
            .filter(decision => decision.toAllocate)
            .map(decision => decision.deployment.ipfsHash),
          activeAllocations: activeAllocations.map(allocation => ({
            id: allocation.id,
            deployment: allocation.subgraphDeployment.id.ipfsHash,
            createdAtEpoch: allocation.createdAtEpoch,
          })),
        })

        return pMap(allocationDecisions, async decision =>
          this.reconcileDeploymentAllocationAction(
            decision,
            epoch,
            maxAllocationEpochs,
            network,
            operator,
          ),
        )
      },
    )
  }

  // TODO:L2: Perform this procedure for all configured networks, not just one
  async ensureNetworkSubgraphIsIndexing(network: Network) {
    if (
      network.specification.subgraphs.networkSubgraph.deployment !== undefined
    ) {
      // Make sure the network subgraph is being indexed
      await this.graphNode.ensure(
        `indexer-agent/${network.specification.subgraphs.networkSubgraph.deployment.slice(
          -10,
        )}`,
        new SubgraphDeploymentID(
          network.specification.subgraphs.networkSubgraph.deployment,
        ),
      )

      // Validate if the Network Subgraph belongs to the current provider's network.
      // This check must be performed after we ensure the Network Subgraph is being indexed.
      try {
        await validateProviderNetworkIdentifier(
          network.specification.networkIdentifier,
          network.specification.subgraphs.networkSubgraph.deployment,
          this.graphNode,
          this.logger,
        )
      } catch (e) {
        this.logger.critical('Failed to validate Network Subgraph. Exiting.', e)
        process.exit(1)
      }
    }
  }
}
