import { Logger, MedusaContainer } from "@medusajs/modules-sdk"
import { EmitData, Subscriber } from "@medusajs/types"
import { AbstractEventBusModuleService } from "@medusajs/utils"
import { EventEmitter } from "events"

type InjectedDependencies = {
  logger: Logger
}

export default class LocalEventBusService extends AbstractEventBusModuleService {
  protected readonly logger_: Logger
  protected readonly eventEmitter_: EventEmitter = new EventEmitter()

  constructor({ logger }: MedusaContainer & InjectedDependencies) {
    // @ts-ignore
    super(...arguments)

    this.logger_ = logger
  }

  async emit<T>(
    eventName: string,
    data: T,
    options: Record<string, unknown>
  ): Promise<void>

  /**
   * Emit a number of events
   * @param {EmitData} data - the data to send to the subscriber.
   */
  async emit<T>(data: EmitData<T>[]): Promise<void>

  async emit<T, TInput extends string | EmitData<T>[] = string>(
    eventOrData: TInput,
    data?: T,
    options: Record<string, unknown> = {}
  ): Promise<void> {
    const isBulkEmit = Array.isArray(eventOrData)

    const events: EmitData[] = isBulkEmit
      ? eventOrData
      : [{ eventName: eventOrData, data }]

    for (const event of events) {
      const eventListenersCount = this.eventEmitter_.listenerCount(
        event.eventName
      )

      if (eventListenersCount === 0) {
        continue
      }

      this.logger_.info(
        `Processing ${event.eventName} which has ${eventListenersCount} subscribers`
      )

      try {
        this.eventEmitter_.emit(event.eventName, event.data)
      } catch (error) {
        this.logger_.error(
          `An error occurred while processing ${event.eventName}: ${error}`
        )
      }
    }
  }

  subscribe(event: string | symbol, subscriber: Subscriber): this {
    this.eventEmitter_.on(event, subscriber)
    return this
  }

  unsubscribe(event: string | symbol, subscriber: Subscriber): this {
    this.eventEmitter_.off(event, subscriber)
    return this
  }
}