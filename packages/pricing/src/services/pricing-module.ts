import {
  Context,
  CreateMoneyAmountDTO,
  DAL,
  FindConfig,
  InternalModuleDeclaration,
  ModuleJoinerConfig,
  PriceSetDTO,
  PricingContext,
  PricingFilters,
  PricingTypes,
  RuleTypeDTO,
} from "@medusajs/types"

import {
  Currency,
  MoneyAmount,
  PriceRule,
  PriceSet,
  PriceSetMoneyAmount,
  PriceSetMoneyAmountRules,
  PriceSetRuleType,
  RuleType,
} from "@models"

import {
  CurrencyService,
  MoneyAmountService,
  PriceRuleService,
  PriceSetMoneyAmountRulesService,
  PriceSetMoneyAmountService,
  PriceSetRuleTypeService,
  PriceSetService,
  RuleTypeService,
} from "@services"

import { EntityManager } from "@mikro-orm/postgresql"

import {
  InjectManager,
  InjectTransactionManager,
  MedusaContext,
  MedusaError,
  groupBy,
  shouldForceTransaction,
} from "@medusajs/utils"

import { AddPricesDTO } from "@medusajs/types"
import { joinerConfig } from "../joiner-config"

type InjectedDependencies = {
  baseRepository: DAL.RepositoryService
  currencyService: CurrencyService<any>
  moneyAmountService: MoneyAmountService<any>
  priceSetService: PriceSetService<any>
  priceSetMoneyAmountRulesService: PriceSetMoneyAmountRulesService<any>
  ruleTypeService: RuleTypeService<any>
  priceRuleService: PriceRuleService<any>
  priceSetRuleTypeService: PriceSetRuleTypeService<any>
  priceSetMoneyAmountService: PriceSetMoneyAmountService<any>
}

export default class PricingModuleService<
  TPriceSet extends PriceSet = PriceSet,
  TMoneyAmount extends MoneyAmount = MoneyAmount,
  TCurrency extends Currency = Currency,
  TRuleType extends RuleType = RuleType,
  TPriceSetMoneyAmountRules extends PriceSetMoneyAmountRules = PriceSetMoneyAmountRules,
  TPriceRule extends PriceRule = PriceRule,
  TPriceSetRuleType extends PriceSetRuleType = PriceSetRuleType,
  TPriceSetMoneyAmount extends PriceSetMoneyAmount = PriceSetMoneyAmount
> implements PricingTypes.IPricingModuleService
{
  protected baseRepository_: DAL.RepositoryService
  protected readonly currencyService_: CurrencyService<TCurrency>
  protected readonly moneyAmountService_: MoneyAmountService<TMoneyAmount>
  protected readonly ruleTypeService_: RuleTypeService<TRuleType>
  protected readonly priceSetService_: PriceSetService<TPriceSet>
  protected readonly priceSetMoneyAmountRulesService_: PriceSetMoneyAmountRulesService<TPriceSetMoneyAmountRules>
  protected readonly priceRuleService_: PriceRuleService<TPriceRule>
  protected readonly priceSetRuleTypeService_: PriceSetRuleTypeService<TPriceSetRuleType>
  protected readonly priceSetMoneyAmountService_: PriceSetMoneyAmountService<TPriceSetMoneyAmount>

  constructor(
    {
      baseRepository,
      moneyAmountService,
      currencyService,
      ruleTypeService,
      priceSetService,
      priceSetMoneyAmountRulesService,
      priceRuleService,
      priceSetRuleTypeService,
      priceSetMoneyAmountService,
    }: InjectedDependencies,
    protected readonly moduleDeclaration: InternalModuleDeclaration
  ) {
    this.baseRepository_ = baseRepository
    this.currencyService_ = currencyService
    this.moneyAmountService_ = moneyAmountService
    this.ruleTypeService_ = ruleTypeService
    this.priceSetService_ = priceSetService
    this.priceSetMoneyAmountRulesService_ = priceSetMoneyAmountRulesService
    this.ruleTypeService_ = ruleTypeService
    this.priceRuleService_ = priceRuleService
    this.priceSetRuleTypeService_ = priceSetRuleTypeService
    this.priceSetMoneyAmountService_ = priceSetMoneyAmountService
  }

  __joinerConfig(): ModuleJoinerConfig {
    return joinerConfig
  }

  @InjectManager("baseRepository_")
  async calculatePrices(
    pricingFilters: PricingFilters,
    pricingContext: PricingContext = { context: {} },
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.CalculatedPriceSetDTO> {
    const manager = sharedContext.manager as EntityManager
    const knex = manager.getKnex()

    // Keeping this whole logic raw in here for now as they will undergo
    // some changes, will abstract them out once we have a final version
    const context = pricingContext.context || {}

    // Quantity is used to scope money amounts based on min_quantity and max_quantity.
    // We should potentially think of reserved words in pricingContext that can't be used in rules
    // or have a separate pricing options that accept things like quantity, price_list_id and other
    // pricing module features
    const quantity = context.quantity
    delete context.quantity

    // Currency code here is a required param.
    const currencyCode = context.currency_code
    delete context.currency_code

    if (!currencyCode) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `currency_code is a required input in the pricing context`
      )
    }

    // Gets all the price set money amounts where rules match for each of the contexts
    // that the price set is configured for
    const psmaSubQueryKnex = knex({
      psma: "price_set_money_amount",
    })
      .select({
        id: "psma.id",
        price_set_id: "psma.price_set_id",
        money_amount_id: "psma.money_amount_id",
        number_rules: "psma.number_rules",
      })
      .leftJoin("price_set_money_amount as psma1", "psma1.id", "psma.id")
      .leftJoin("price_rule as pr", "pr.price_set_money_amount_id", "psma.id")
      .leftJoin("rule_type as rt", "rt.id", "pr.rule_type_id")
      .orderBy("number_rules", "desc")
      .orWhere("psma1.number_rules", "=", 0)
      .groupBy("psma.id")
      .having(knex.raw("count(DISTINCT rt.rule_attribute) = psma.number_rules"))

    for (const [key, value] of Object.entries(context)) {
      psmaSubQueryKnex.orWhere({
        "rt.rule_attribute": key,
        "pr.value": value,
      })
    }

    const priceSetQueryKnex = knex({
      ps: "price_set",
    })
      .select({
        id: "ps.id",
        amount: "ma.amount",
        min_quantity: "ma.min_quantity",
        max_quantity: "ma.max_quantity",
        currency_code: "ma.currency_code",
        default_priority: "rt.default_priority",
        number_rules: "psma.number_rules",
      })
      .join(psmaSubQueryKnex.as("psma"), "psma.price_set_id", "ps.id")
      .join("money_amount as ma", "ma.id", "psma.money_amount_id")
      .leftJoin("price_rule as pr", "pr.price_set_money_amount_id", "psma.id")
      .leftJoin("rule_type as rt", "rt.id", "pr.rule_type_id")
      .whereIn("ps.id", pricingFilters.id)
      .andWhere("ma.currency_code", "=", currencyCode)
      .orderBy([
        { column: "number_rules", order: "desc" },
        { column: "default_priority", order: "desc" },
      ])

    if (quantity) {
      priceSetQueryKnex.where("ma.min_quantity", "<=", quantity)
      priceSetQueryKnex.andWhere("ma.max_quantity", ">=", quantity)
    }

    const isContextPresent = Object.entries(context).length || !!currencyCode
    // Only if the context is present do we need to query the database.
    const queryBuilderResults = isContextPresent ? await priceSetQueryKnex : []
    const pricesSetPricesMap = groupBy(queryBuilderResults, "id")

    const calculatedPrices = pricingFilters.id.map(
      (priceSetId: string): PricingTypes.CalculatedPriceSetDTO => {
        // This is where we select prices, for now we just do a first match based on the database results
        // which is prioritized by number_rules first for exact match and then deafult_priority of the rule_type
        // inject custom price selection here
        const price = pricesSetPricesMap.get(priceSetId)?.[0]

        return {
          id: priceSetId,
          amount: price?.amount || null,
          currency_code: price?.currency_code || null,
          min_quantity: price?.min_quantity || null,
          max_quantity: price?.max_quantity || null,
        }
      }
    )

    return JSON.parse(JSON.stringify(calculatedPrices))
  }

  @InjectManager("baseRepository_")
  async retrieve(
    id: string,
    config: FindConfig<PricingTypes.PriceSetDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceSetDTO> {
    const priceSet = await this.priceSetService_.retrieve(
      id,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.PriceSetDTO>(priceSet, {
      populate: true,
    })
  }

  @InjectManager("baseRepository_")
  async list(
    filters: PricingTypes.FilterablePriceSetProps = {},
    config: FindConfig<PricingTypes.PriceSetDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceSetDTO[]> {
    const priceSets = await this.priceSetService_.list(
      filters,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.PriceSetDTO[]>(
      priceSets,
      {
        populate: true,
      }
    )
  }

  @InjectManager("baseRepository_")
  async listAndCount(
    filters: PricingTypes.FilterablePriceSetProps = {},
    config: FindConfig<PricingTypes.PriceSetDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<[PricingTypes.PriceSetDTO[], number]> {
    const [priceSets, count] = await this.priceSetService_.listAndCount(
      filters,
      config,
      sharedContext
    )

    return [
      await this.baseRepository_.serialize<PricingTypes.PriceSetDTO[]>(
        priceSets,
        {
          populate: true,
        }
      ),
      count,
    ]
  }
  @InjectManager("baseRepository_")
  async create(
    data: PricingTypes.CreatePriceSetDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceSetDTO[]> {
    const priceSets = await this.create_(data, sharedContext)

    return this.list(
      { id: priceSets.filter((p) => !!p).map((p) => p!.id) },
      {
        relations: ["rule_types", "money_amounts", "price_rules"],
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  protected async create_(
    data: PricingTypes.CreatePriceSetDTO[],
    @MedusaContext() sharedContext: Context = {}
  ) {
    const ruleAttributes = data
      .map((d) => d.rules?.map((r) => r.rule_attribute) ?? [])
      .flat()

    const ruleTypes = await this.ruleTypeService_.list(
      {
        rule_attribute: ruleAttributes,
      },
      {},
      sharedContext
    )

    const ruleTypeMap = ruleTypes.reduce((acc, curr) => {
      acc.set(curr.rule_attribute, curr)
      return acc
    }, new Map())

    const invalidRuleAttributes = ruleAttributes.filter(
      (r) => !ruleTypeMap.has(r)
    )

    if (invalidRuleAttributes.length > 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Rule types don't exist for: ${invalidRuleAttributes.join(", ")}`
      )
    }

    const invalidMoneyAmountRule = data
      .map(
        (d) => d.money_amounts?.map((ma) => Object.keys(ma.rules)).flat() ?? []
      )
      .flat()
      .filter((r) => !ruleTypeMap.has(r))

    if (invalidMoneyAmountRule.length > 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Rule types don't exist for money amounts with rule attribute: ${invalidMoneyAmountRule.join(
          ", "
        )}`
      )
    }

    const priceSets = await Promise.all(
      data.map(async (d) => {
        const { rules, money_amounts, ...rest } = d
        const [priceSet] = await this.priceSetService_.create(
          [rest],
          sharedContext
        )

        if (rules?.length) {
          const priceSetRuleTypesCreate = rules!.map((r) => ({
            rule_type: ruleTypeMap.get(r.rule_attribute),
            price_set: priceSet,
          }))

          await this.priceSetRuleTypeService_.create(
            priceSetRuleTypesCreate as unknown as PricingTypes.CreatePriceSetRuleTypeDTO[],
            sharedContext
          )
        }

        if (money_amounts?.length) {
          await money_amounts.forEach(async (ma) => {
            const [moneyAmount] = await this.moneyAmountService_.create(
              [ma] as unknown as CreateMoneyAmountDTO[],
              sharedContext
            )

            const numberOfRules = Object.entries(ma.rules).length

            const [priceSetMoneyAmount] =
              await this.priceSetMoneyAmountService_.create(
                [
                  {
                    price_set: priceSet,
                    money_amount: moneyAmount,
                    title: "test",
                    number_rules: numberOfRules,
                  },
                ] as unknown as PricingTypes.CreatePriceSetMoneyAmountDTO[],
                sharedContext
              )

            if (numberOfRules) {
              const priceSetRulesCreate = Object.entries(ma.rules).map(
                ([k, v]) => ({
                  price_set_money_amount: priceSetMoneyAmount,
                  rule_type: ruleTypeMap.get(k),
                  price_set: priceSet,
                  value: v,
                  price_list_id: "test",
                })
              )

              await this.priceRuleService_.create(
                priceSetRulesCreate as unknown as PricingTypes.CreatePriceRuleDTO[],
                sharedContext
              )
            }
          })
        }

        return priceSet
      })
    )

    return priceSets
  }

  async addRules<
    TInput extends PricingTypes.AddRulesDTO | PricingTypes.AddRulesDTO[],
    TOutput = TInput extends PricingTypes.AddRulesDTO[]
      ? PricingTypes.PriceSetDTO[]
      : PricingTypes.PriceSetDTO
  >(
    data: PricingTypes.AddRulesDTO | PricingTypes.AddRulesDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<TOutput> {
    const inputs = Array.isArray(data) ? data : [data]

    const priceSets = await this.addRules_(inputs, sharedContext)

    return (Array.isArray(data)
      ? priceSets
      : priceSets[0]) as unknown as TOutput
  }

  protected async addRules_(
    inputs: PricingTypes.AddRulesDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceSetDTO[]> {
    const priceSets = await this.priceSetService_.list(
      { id: inputs.map((d) => d.priceSetId) },
      { relations: ["rule_types"] }
    )

    const priceSetRuleTypeMap: Map<string, Map<string, RuleTypeDTO>> = new Map(
      priceSets.map((priceSet) => [
        priceSet.id,
        new Map([...priceSet.rule_types].map((rt) => [rt.rule_attribute, rt])),
      ])
    )

    const priceSetMap = new Map(priceSets.map((p) => [p.id, p]))

    const invalidPriceSetInputs = inputs.filter(
      (d) => !priceSetMap.has(d.priceSetId)
    )

    if (invalidPriceSetInputs.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `PriceSets with ids: ${invalidPriceSetInputs
          .map((d) => d.priceSetId)
          .join(", ")} was not found`
      )
    }

    const ruleTypes = await this.ruleTypeService_.list(
      {
        rule_attribute: inputs
          .map((d) => d.rules.map((r) => r.attribute))
          .flat(),
      },
      {},
      sharedContext
    )

    const ruleTypeMap: Map<string, RuleTypeDTO> = new Map(
      ruleTypes.map((rt) => [rt.rule_attribute, rt])
    )

    const invalidRuleAttributeInputs = inputs
      .map((d) => d.rules.map((r) => r.attribute))
      .flat()
      .filter((r) => !ruleTypeMap.has(r))

    if (invalidRuleAttributeInputs.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Rule types don't exist for attributes: ${[
          ...new Set(invalidRuleAttributeInputs),
        ].join(", ")}`
      )
    }

    const priceSetRuleTypesCreate: PricingTypes.CreatePriceSetRuleTypeDTO[] = []

    inputs.forEach((d) => {
      const priceSet = priceSetMap.get(d.priceSetId)

      for (const r of d.rules) {
        if (priceSetRuleTypeMap.get(d.priceSetId)!.has(r.attribute)) {
          continue
        }

        priceSetRuleTypesCreate.push({
          rule_type: ruleTypeMap.get(r.attribute) as RuleTypeDTO,
          price_set: priceSet as unknown as PriceSetDTO,
        })
      }
    })

    await this.priceSetRuleTypeService_.create(
      priceSetRuleTypesCreate as unknown as PricingTypes.CreatePriceSetRuleTypeDTO[],
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.PriceSetDTO[]>(
      priceSets,
      {
        populate: true,
      }
    )
  }

  @InjectManager("baseRepository_")
  async addPrices(
    data: AddPricesDTO | AddPricesDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceSetDTO[]> {
    const input = Array.isArray(data) ? data : [data]

    await this.addPrices_(input, sharedContext)

    return await this.list(
      { id: input.map((d) => d.priceSetId) },
      { relations: ["money_amounts"] }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  protected async addPrices_(
    input: AddPricesDTO[],
    @MedusaContext() sharedContext: Context = {}
  ) {
    const priceSets = await this.list(
      { id: input.map((d) => d.priceSetId) },
      { relations: ["rule_types"] },
      sharedContext
    )

    const priceSetMap = new Map(priceSets.map((p) => [p.id, p]))

    const ruleTypeMap: Map<string, Map<string, RuleTypeDTO>> = new Map(
      priceSets.map((priceSet) => [
        priceSet.id,
        new Map(
          priceSet.rule_types?.map((rt) => [rt.rule_attribute, rt]) ?? []
        ),
      ])
    )

    input.forEach(({ priceSetId, prices }) => {
      const priceSet = priceSetMap.get(priceSetId)

      if (!priceSet) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Price set with id: ${priceSetId} not found`
        )
      }

      const ruleAttributes = prices
        .map((d) => (d.rules ? Object.keys(d.rules) : []))
        .flat()

      const invalidRuleAttributes = ruleAttributes.filter(
        (r) => !ruleTypeMap.get(priceSetId)!.has(r)
      )

      if (invalidRuleAttributes.length > 0) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          `Rule types don't exist for: ${invalidRuleAttributes.join(", ")}`
        )
      }
    })

    for(const { priceSetId, prices } of input) {
      await Promise.all(
        prices.map(async (ma) => {
          const [moneyAmount] = await this.moneyAmountService_.create(
            [ma] as unknown as CreateMoneyAmountDTO[],
            sharedContext
          )

          const numberOfRules = Object.entries(ma?.rules ?? {}).length

          const [priceSetMoneyAmount] =
            await this.priceSetMoneyAmountService_.create(
              [
                {
                  price_set: priceSetId,
                  money_amount: moneyAmount,
                  title: "test",
                  number_rules: numberOfRules,
                },
              ] as unknown as PricingTypes.CreatePriceSetMoneyAmountDTO[],
              sharedContext
            )

          if (numberOfRules) {
            const priceSetRulesCreate = Object.entries(ma.rules!).map(
              ([k, v]) => ({
                price_set_money_amount: priceSetMoneyAmount,
                rule_type: ruleTypeMap.get(priceSetId)!.get(k),
                price_set: priceSetId,
                value: v,
                price_list_id: "test",
              })
            )

            await this.priceRuleService_.create(
              priceSetRulesCreate as unknown as PricingTypes.CreatePriceRuleDTO[],
              sharedContext
            )
          }

          return moneyAmount
        })
      )
    }

    return priceSets
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async removeRules(
    data: PricingTypes.RemovePriceSetRulesDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const priceSets = await this.priceSetService_.list({
      id: data.map((d) => d.id),
    })
    const priceSetIds = priceSets.map((ps) => ps.id)

    const ruleTypes = await this.ruleTypeService_.list({
      rule_attribute: data.map((d) => d.rules || []).flat(),
    })
    const ruleTypeIds = ruleTypes.map((rt) => rt.id)

    const priceSetRuleTypes = await this.priceSetRuleTypeService_.list({
      price_set_id: priceSetIds,
      rule_type_id: ruleTypeIds,
    })

    const priceRules = await this.priceRuleService_.list(
      {
        price_set_id: priceSetIds,
        rule_type_id: ruleTypeIds,
      },
      {
        select: ["price_set_money_amount"],
      }
    )

    await this.priceSetRuleTypeService_.delete(
      priceSetRuleTypes.map((psrt) => psrt.id),
      sharedContext
    )

    await this.priceSetMoneyAmountService_.delete(
      priceRules.map((pr) => pr.price_set_money_amount.id),
      sharedContext
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async update(
    data: PricingTypes.UpdatePriceSetDTO[],
    @MedusaContext() sharedContext: Context = {}
  ) {
    const priceSets = await this.priceSetService_.update(data, sharedContext)

    return this.baseRepository_.serialize<PricingTypes.PriceSetDTO[]>(
      priceSets,
      {
        populate: true,
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async delete(
    ids: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    await this.priceSetService_.delete(ids, sharedContext)
  }

  @InjectManager("baseRepository_")
  async retrieveMoneyAmount(
    id: string,
    config: FindConfig<PricingTypes.MoneyAmountDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.MoneyAmountDTO> {
    const moneyAmount = await this.moneyAmountService_.retrieve(
      id,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.MoneyAmountDTO>(
      moneyAmount,
      {
        populate: true,
      }
    )
  }

  @InjectManager("baseRepository_")
  async listMoneyAmounts(
    filters: PricingTypes.FilterableMoneyAmountProps = {},
    config: FindConfig<PricingTypes.MoneyAmountDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.MoneyAmountDTO[]> {
    const moneyAmounts = await this.moneyAmountService_.list(
      filters,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.MoneyAmountDTO[]>(
      moneyAmounts,
      {
        populate: true,
      }
    )
  }

  @InjectManager("baseRepository_")
  async listAndCountMoneyAmounts(
    filters: PricingTypes.FilterableMoneyAmountProps = {},
    config: FindConfig<PricingTypes.MoneyAmountDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<[PricingTypes.MoneyAmountDTO[], number]> {
    const [moneyAmounts, count] = await this.moneyAmountService_.listAndCount(
      filters,
      config,
      sharedContext
    )

    return [
      await this.baseRepository_.serialize<PricingTypes.MoneyAmountDTO[]>(
        moneyAmounts,
        {
          populate: true,
        }
      ),
      count,
    ]
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async createMoneyAmounts(
    data: PricingTypes.CreateMoneyAmountDTO[],
    @MedusaContext() sharedContext: Context = {}
  ) {
    const moneyAmounts = await this.moneyAmountService_.create(
      data,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.MoneyAmountDTO[]>(
      moneyAmounts,
      {
        populate: true,
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async updateMoneyAmounts(
    data: PricingTypes.UpdateMoneyAmountDTO[],
    @MedusaContext() sharedContext: Context = {}
  ) {
    const moneyAmounts = await this.moneyAmountService_.update(
      data,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.MoneyAmountDTO[]>(
      moneyAmounts,
      {
        populate: true,
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async deleteMoneyAmounts(
    ids: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    await this.moneyAmountService_.delete(ids, sharedContext)
  }

  @InjectManager("baseRepository_")
  async retrieveCurrency(
    code: string,
    config: FindConfig<PricingTypes.CurrencyDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.CurrencyDTO> {
    const currency = await this.currencyService_.retrieve(
      code,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.CurrencyDTO>(currency, {
      populate: true,
    })
  }

  @InjectManager("baseRepository_")
  async listCurrencies(
    filters: PricingTypes.FilterableCurrencyProps = {},
    config: FindConfig<PricingTypes.CurrencyDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.CurrencyDTO[]> {
    const currencies = await this.currencyService_.list(
      filters,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.CurrencyDTO[]>(
      currencies,
      {
        populate: true,
      }
    )
  }

  @InjectManager("baseRepository_")
  async listAndCountCurrencies(
    filters: PricingTypes.FilterableCurrencyProps = {},
    config: FindConfig<PricingTypes.CurrencyDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<[PricingTypes.CurrencyDTO[], number]> {
    const [currencies, count] = await this.currencyService_.listAndCount(
      filters,
      config,
      sharedContext
    )

    return [
      await this.baseRepository_.serialize<PricingTypes.CurrencyDTO[]>(
        currencies,
        {
          populate: true,
        }
      ),
      count,
    ]
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async createCurrencies(
    data: PricingTypes.CreateCurrencyDTO[],
    @MedusaContext() sharedContext: Context = {}
  ) {
    const currencies = await this.currencyService_.create(data, sharedContext)

    return this.baseRepository_.serialize<PricingTypes.CurrencyDTO[]>(
      currencies,
      {
        populate: true,
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async updateCurrencies(
    data: PricingTypes.UpdateCurrencyDTO[],
    @MedusaContext() sharedContext: Context = {}
  ) {
    const currencies = await this.currencyService_.update(data, sharedContext)

    return this.baseRepository_.serialize<PricingTypes.CurrencyDTO[]>(
      currencies,
      {
        populate: true,
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async deleteCurrencies(
    currencyCodes: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    await this.currencyService_.delete(currencyCodes, sharedContext)
  }

  @InjectManager("baseRepository_")
  async retrieveRuleType(
    id: string,
    config: FindConfig<PricingTypes.RuleTypeDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.RuleTypeDTO> {
    const ruleType = await this.ruleTypeService_.retrieve(
      id,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.RuleTypeDTO>(ruleType, {
      populate: true,
    })
  }

  @InjectManager("baseRepository_")
  async listRuleTypes(
    filters: PricingTypes.FilterableRuleTypeProps = {},
    config: FindConfig<PricingTypes.RuleTypeDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.RuleTypeDTO[]> {
    const ruleTypes = await this.ruleTypeService_.list(
      filters,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.RuleTypeDTO[]>(
      ruleTypes,
      {
        populate: true,
      }
    )
  }

  @InjectManager("baseRepository_")
  async listAndCountRuleTypes(
    filters: PricingTypes.FilterableRuleTypeProps = {},
    config: FindConfig<PricingTypes.RuleTypeDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<[PricingTypes.RuleTypeDTO[], number]> {
    const [ruleTypes, count] = await this.ruleTypeService_.listAndCount(
      filters,
      config,
      sharedContext
    )

    return [
      await this.baseRepository_.serialize<PricingTypes.RuleTypeDTO[]>(
        ruleTypes,
        {
          populate: true,
        }
      ),
      count,
    ]
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async createRuleTypes(
    data: PricingTypes.CreateRuleTypeDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.RuleTypeDTO[]> {
    const ruleTypes = await this.ruleTypeService_.create(data, sharedContext)

    return this.baseRepository_.serialize<PricingTypes.RuleTypeDTO[]>(
      ruleTypes,
      {
        populate: true,
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async updateRuleTypes(
    data: PricingTypes.UpdateRuleTypeDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.RuleTypeDTO[]> {
    const ruleTypes = await this.ruleTypeService_.update(data, sharedContext)

    return this.baseRepository_.serialize<PricingTypes.RuleTypeDTO[]>(
      ruleTypes,
      {
        populate: true,
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async deleteRuleTypes(
    ruleTypes: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    await this.ruleTypeService_.delete(ruleTypes, sharedContext)
  }

  @InjectManager("baseRepository_")
  async retrievePriceSetMoneyAmountRules(
    id: string,
    config: FindConfig<PricingTypes.PriceSetMoneyAmountRulesDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceSetMoneyAmountRulesDTO> {
    const record = await this.priceSetMoneyAmountRulesService_.retrieve(
      id,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.PriceSetMoneyAmountRulesDTO>(
      record,
      {
        populate: true,
      }
    )
  }

  @InjectManager("baseRepository_")
  async listPriceSetMoneyAmountRules(
    filters: PricingTypes.FilterablePriceSetMoneyAmountRulesProps = {},
    config: FindConfig<PricingTypes.PriceSetMoneyAmountRulesDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceSetMoneyAmountRulesDTO[]> {
    const records = await this.priceSetMoneyAmountRulesService_.list(
      filters,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<
      PricingTypes.PriceSetMoneyAmountRulesDTO[]
    >(records, {
      populate: true,
    })
  }

  @InjectManager("baseRepository_")
  async listAndCountPriceSetMoneyAmountRules(
    filters: PricingTypes.FilterablePriceSetMoneyAmountRulesProps = {},
    config: FindConfig<PricingTypes.PriceSetMoneyAmountRulesDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<[PricingTypes.PriceSetMoneyAmountRulesDTO[], number]> {
    const [records, count] =
      await this.priceSetMoneyAmountRulesService_.listAndCount(
        filters,
        config,
        sharedContext
      )

    return [
      await this.baseRepository_.serialize<
        PricingTypes.PriceSetMoneyAmountRulesDTO[]
      >(records, {
        populate: true,
      }),
      count,
    ]
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async createPriceSetMoneyAmountRules(
    data: PricingTypes.CreatePriceSetMoneyAmountRulesDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceSetMoneyAmountRulesDTO[]> {
    const records = await this.priceSetMoneyAmountRulesService_.create(
      data,
      sharedContext
    )

    return this.baseRepository_.serialize<
      PricingTypes.PriceSetMoneyAmountRulesDTO[]
    >(records, {
      populate: true,
    })
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async updatePriceSetMoneyAmountRules(
    data: PricingTypes.UpdatePriceSetMoneyAmountRulesDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceSetMoneyAmountRulesDTO[]> {
    const records = await this.priceSetMoneyAmountRulesService_.update(
      data,
      sharedContext
    )

    return this.baseRepository_.serialize<
      PricingTypes.PriceSetMoneyAmountRulesDTO[]
    >(records, {
      populate: true,
    })
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async deletePriceSetMoneyAmountRules(
    ids: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    await this.priceSetMoneyAmountRulesService_.delete(ids, sharedContext)
  }

  @InjectManager("baseRepository_")
  async retrievePriceRule(
    id: string,
    config: FindConfig<PricingTypes.PriceRuleDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceRuleDTO> {
    const priceRule = await this.priceRuleService_.retrieve(
      id,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.PriceRuleDTO>(
      priceRule,
      {
        populate: true,
      }
    )
  }

  @InjectManager("baseRepository_")
  async listPriceRules(
    filters: PricingTypes.FilterablePriceRuleProps = {},
    config: FindConfig<PricingTypes.PriceRuleDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceRuleDTO[]> {
    const priceRules = await this.priceRuleService_.list(
      filters,
      config,
      sharedContext
    )

    return this.baseRepository_.serialize<PricingTypes.PriceRuleDTO[]>(
      priceRules,
      {
        populate: true,
      }
    )
  }

  @InjectManager("baseRepository_")
  async listAndCountPriceRules(
    filters: PricingTypes.FilterablePriceRuleProps = {},
    config: FindConfig<PricingTypes.PriceRuleDTO> = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<[PricingTypes.PriceRuleDTO[], number]> {
    const [priceRules, count] = await this.priceRuleService_.listAndCount(
      filters,
      config,
      sharedContext
    )

    return [
      await this.baseRepository_.serialize<PricingTypes.PriceRuleDTO[]>(
        priceRules,
        {
          populate: true,
        }
      ),
      count,
    ]
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async createPriceRules(
    data: PricingTypes.CreatePriceRuleDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceRuleDTO[]> {
    const priceRules = await this.priceRuleService_.create(data, sharedContext)

    return this.baseRepository_.serialize<PricingTypes.PriceRuleDTO[]>(
      priceRules,
      {
        populate: true,
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async updatePriceRules(
    data: PricingTypes.UpdatePriceRuleDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<PricingTypes.PriceRuleDTO[]> {
    const priceRules = await this.priceRuleService_.update(data, sharedContext)

    return this.baseRepository_.serialize<PricingTypes.PriceRuleDTO[]>(
      priceRules,
      {
        populate: true,
      }
    )
  }

  @InjectTransactionManager(shouldForceTransaction, "baseRepository_")
  async deletePriceRules(
    priceRuleIds: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    await this.priceRuleService_.delete(priceRuleIds, sharedContext)
  }
}
