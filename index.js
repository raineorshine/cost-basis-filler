const fs = require('fs')
const csvtojson = require('csvtojson')
const json2csv = require('json2csv')
const got = require('got')
const secure = require('./secure.json')
const memoize = require('nano-persistent-memoizer')
const Stock = require('./stock.js')
const stock = Stock()

const defaultExchange = 'cccagg' // cryptocompare aggregrate
const mockPrice = false

const airdropSymbols = { AIMS: 1, AMM: 1, ARCONA: 1, BEAUTY: 1, blockwel: 1, BNB: 1, BOBx: 1, BULLEON: 1, CAN: 1, CANDY: 1, CAT: 1, CGW: 1, CLN: 1, cryptics: 1, DATA: 1, ELEC: 1, ERC20: 1, EMO: 1, ETP: 1, 'FIFA.win': 1, FIFAmini: 1, FREE: 1, Googol: 1, HEALP: 1, HKY: 1, HMC: 1, HSC: 1, HuobiAir: 1, HUR: 1, IBA: 1, INSP: 1, JOT: 1, LPT: 1, OCEAN: 1, OCN: 1, Only: 1, PCBC: 1, PMOD: 1, R: 1, 'safe.ad': 1, SCB: 1, SNGX: 1, SSS: 1, SW: 1, TOPB: 1, TOPBTC: 1, TRX: 1, UBT: 1, VENT: 1, VIN: 1, VIU: 1, VKT: 1, 'VOS.AI': 1, WIN: 1, WLM: 1, WOLK: 1, XNN: 1, ZNT: 1 }

// replace duplicate Cur. with CurBuy, CurSell, CurFee
const fixHeader = input => {
  const lines = input.split('\n')
  return [].concat(
    lines[0]
      .replace('Cur.', 'CurBuy')
      .replace('Cur.', 'CurSell')
      .replace('Cur.', 'CurFee'),
    lines.slice(1)
  ).join('\n')
}

// convert trades array to CSV and restore header
const toCSV = (trades, fields=['Type','Buy','CurBuy','Sell','CurSell','Exchange','Trade Group',,,'Comment','Trade Date']) => {
  const csv = json2csv.parse(trades, { delimiter: ',', fields })
  const csvLines = csv.split('\n')
  return [].concat(
    csvLines[0]
      .replace('CurBuy', 'Cur.')
      .replace('CurSell', 'Cur.')
      .replace('CurFee', 'Cur.'),
    csvLines.slice(1)
  ).join('\n')
}

// group transactions by day
const groupByDay = trades => {
  const txsByDay = {}
  for (let i=0; i<trades.length; i++) {
    const key = day(trades[i]['Trade Date'])
    if (!(key in txsByDay)) {
      txsByDay[key] = []
    }
    txsByDay[key].push(trades[i])
  }
  return txsByDay
}

// get the day of the date
const day = date => date.split(' ')[0]

// convert to y-m-d
const normalDate = tx => {
  const d = tx['Trade Date']
  return `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)} ${d.slice(11)}`
  // 18.06.2016 15:14 0
}

// get the opposite tx type: Deposit/Withdrawal
const otherType = tx => tx.Type === 'Deposit' ? 'Withdrawal' : 'Deposit'

// convert a string value to a number and set '-' to 0
const z = v => v === '-' ? 0 : +v

// checks if two txs are within a margin of error from each other
const closeEnough = (tx1, tx2) => {
  return Math.abs(z(tx1.Buy) - z(tx2.Sell)) <= 0.02 &&
         Math.abs(z(tx1.Sell) - z(tx2.Buy)) <= 0.02
}

// checks if a tx is too small to count based on a token-specific size
// const tooSmallToCount = tx => {
//   const tooSmallAmount =
//     tx.CurBuy === 'BTC' ? 0.0001 :
//     tx.CurBuy === 'ETH' ? 0.001 :
//     0.005
//   return z(tx.Buy) < tooSmallAmount &&
//          z(tx.Sell) < tooSmallAmount
// }

// checks if two transactions are a Deposit/Withdrawal match
const match = (tx1, tx2) =>
  tx1.Type === otherType(tx2.Type) &&
  tx1.CurBuy === tx2.CurSell &&
  tx1.CurSell === tx2.CurBuy &&
  closeEnough(tx1, tx2)

// memoized price
const mPrice = memoize('price').async(async key => {
  const { from, to, time, exchange } = JSON.parse(key)
  const url = `https://min-api.cryptocompare.com/data/pricehistorical?fsym=${from}&tsyms=${to}&ts=${(new Date(time)).getTime()/1000}&e=${exchange}&api_key=${secure.cryptoCompareApiKey}&extraParams=cost-basis-filler`
  const data = JSON.parse((await got(url)).body)

  if (data[from]) {
    return data[from][to]
  }
  else if (data.Message.startsWith('There is no data for the symbol')) {
    throw new Error(`No price for ${from} on ${time}`)
  }
  else if (data.Response === 'Error') {
    throw new Error(data.Message)
  }
  else {
    throw new Error('Unknown Response', data)
  }
})

const price = mockPrice
  ? (async () => 0)
  // stringify arguments into caching key for memoize
  : async (from, to, time, exchange = defaultExchange) => +(await mPrice(JSON.stringify({ from, to, time, exchange })))

// USD buy = crypto sale
const isUsdBuy = trade =>
  ((trade.Type === 'Withdrawal' && trade.Exchange === 'Coinbase' && !trade.Fee && trade.Sell < 4) || // shift card (infer)
  (trade.Type === 'Trade' && trade.CurBuy === 'USD')) && // Crypto Sale
  trade.CurSell !== 'USDT' // not tether

// find a withdrawal in the given list of transactions that matches the given deposit
const findMatchingWithdrawal = (deposit, txs) =>
  txs.find(tx => match(deposit, tx))


/****************************************************************
* CALCULATE
*****************************************************************/

// group transactions into several broad categories
// match same-day withdrawals and deposits
// calculate custom cost basis
const calculate = async txs => {

  const matched = []
  const unmatched = []
  const income = []
  const usdBuys = []
  const usdDeposits = []
  const withdrawals = []
  const margin = []
  const lending = []
  const tradeTxs = []
  const lost = []
  const spend = []
  const airdrops = []

  const sales = []
  const likeKindExchanges = []
  const noAvailablePurchases = []
  const noMatchingWithdrawals = []
  const priceErrors = []

  const txsByDay = groupByDay(txs)

  // loop through each day
  for (let key in txsByDay) {
    const group = txsByDay[key]

    // loop through each of the day's transactions
    for (let i in group) {
      const tx = group[i]

      // LENDING

      // must go ahead of Trade
      if(/lending/i.test(tx['Trade Group']) || /lending/i.test(tx.Comment)) {
        lending.push(tx)
      }

      // MARGIN

      else if(/margin/i.test(tx['Trade Group']) || /margin/i.test(tx.Comment)) {
        margin.push(tx)
      }

      // SALE

      // USD buy = crypto sale
      // must go ahead of Trade and Withdrawal
      else if(isUsdBuy(tx)) {
        usdBuys.push(tx)

        // update cost basis
        try {
          // Trade to USD
          if (tx.Type === 'Trade') {
            sales.push(...stock.trade(+tx.Sell, tx.CurSell, +tx.Buy, 'USD', tx['Trade Date']))
          }
          // Shift: we have to calculate the historical USD sale value since Coinbase only provides the token price
          else {
            let p = 0
            try {
              p = await price(tx.CurSell, 'USD', day(normalDate(tx)), 'coinbase')
            }
            catch(e) {
              console.error(`Error fetching price`, e.message)
              priceErrors.push(tx)
            }

            sales.push(...stock.trade(+tx.Sell, tx.CurSell, tx.Sell * p, 'USD', tx['Trade Date']))
          }
        }
        catch (e) {
          if (e instanceof Stock.NoAvailablePurchaseError) {
            console.error(e.message)
            noAvailablePurchases.push(e)
          }
          else {
            throw e
          }
        }
      }

      // TRADE

      // crypto-to-crypto trade
      else if(tx.Type === 'Trade') {
        tradeTxs.push(tx)

        // update cost basis
        try {
          const before2018 = (new Date(normalDate(tx))).getFullYear() < 2018
          const tradeExchanges = stock.trade(+tx.Sell, tx.CurSell, +tx.Buy, tx.CurBuy, tx['Trade Date'], before2018 ? null : await price(tx.CurBuy, 'USD', day(normalDate(tx))))
          ;(before2018 ? likeKindExchanges : sales)
            .push(...tradeExchanges)
        }
        catch (e) {
          if (e instanceof Stock.NoAvailablePurchaseError) {
            console.error('Error making trade:', e.message)
            noAvailablePurchases.push(e)
          }
          else {
            throw e
          }
        }

      }
      else if(tx.Type === 'Income') {
        income.push(tx)

        // update cost basis
        let p = 0
        try {
          p = await price(tx.CurBuy, 'USD', day(normalDate(tx)))
        }
        catch(e) {
          console.error(`Error fetching price`, e.message)
          priceErrors.push(tx)
        }
        stock.deposit(+tx.Buy, tx.CurBuy, tx.Buy * p, tx['Trade Date'])
      }

      // DEPOSIT
 else if (tx.Type === 'Deposit') {

        // USD deposits have as-is cost basis
        if (tx.CurBuy === 'USD') {
          usdDeposits.push(tx)
          stock.deposit(+tx.Buy, 'USD', tx.Buy, tx['Trade Date'])
        }
        // air drops have cost basis of 0
        else if (tx.CurBuy in airdropSymbols) {
          airdrops.push(tx)
          stock.deposit(+tx.Buy, tx.CurBuy, 0, tx['Trade Date'])
        }
        // try to match the deposit to a same-day withdrawal
        else if (findMatchingWithdrawal(tx, group)) {
          matched.push(tx)
        }
        // otherwise we have an unmatched transaction and need to fallback to the day-of price
        // and add it to the stock
        else {
          const message = `WARNING: No matching withdrawal for deposit of ${tx.Buy} ${tx.CurBuy} on ${tx['Trade Date']}. Using historical price.`
          console.warn(message)
          noMatchingWithdrawals.push(message)

          let p
          try {
            // per-day memoization
            p = await price(tx.CurBuy, 'USD', day(normalDate(tx)))
          }
          catch (e) {
            priceErrors.push(e.message)
          }

          const newTx = Object.assign({}, tx, {
            Type: 'Income',
            Comment: 'Cost Basis',
            Price: p
          })

          unmatched.push(newTx)

          // cost basis based on day-of price
          stock.deposit(+tx.Buy, tx.CurBuy, tx.Buy * p, tx['Trade Date'])
        }

      }

      // OTHER

      else if (tx.Type === 'Withdrawal') {
        withdrawals.push(tx)
      }
      else if (tx.Type === 'Lost') {
        lost.push(tx)
      }
      else if (tx.Type === 'Spend') {
        spend.push(tx)
      }
      else {
        throw new Error('I do not know how to handle this transaction: \n\n' + JSON.stringify(tx))
      }
    }
  }

  return { matched, unmatched, income, usdBuys, airdrops, usdDeposits, withdrawals, tradeTxs, lost, spend, margin, lending, sales, likeKindExchanges, noAvailablePurchases, noMatchingWithdrawals, priceErrors }
}


/****************************************************************
* RUN
*****************************************************************/

const file = process.argv[2]
const command = process.argv[3]
const sampleSize = process.argv[4] || Infinity

if (!file) {
  console.error('Please specify a file. \n\nUsage: \nnode index.js [transactions.csv] command')
  process.exit(1)
}

// import csv

(async () => {

const input = fixHeader(fs.readFileSync(file, 'utf-8'))
const txs = Array.prototype.slice.call(await csvtojson().fromString(input)) // convert to true array

const { matched, unmatched, income, usdBuys, airdrops, usdDeposits, withdrawals, tradeTxs, lost, spend, margin, lending, sales, likeKindExchanges, noAvailablePurchases, noMatchingWithdrawals, priceErrors } = await calculate(txs)


/************************************************************************
 * SUMMARY
 ************************************************************************/
if (command === 'summary') {

  const sum = withdrawals.length + matched.length + unmatched.length + usdBuys.length + airdrops.length + usdDeposits.length + income.length + tradeTxs.length + margin.length + lending.length + lost.length + spend.length

  console.log('')
  console.log('Withdrawals:', withdrawals.length)
  console.log('Matched Deposits:', matched.length)
  console.log('Unmatched Deposits:', unmatched.length)
  console.log('USD Buys:', usdBuys.length)
  console.log('USD Deposits:', usdDeposits.length)
  console.log('Airdrops', airdrops.length)
  console.log('Income:', income.length)
  console.log('Trades:', tradeTxs.length)
  console.log('Margin Trades:', margin.length)
  console.log('Lending:', lending.length)
  console.log('Lost:', lost.length)
  console.log('Spend:', spend.length)
  console.log(sum === txs.length
    ? `TOTAL: ${sum} ✓`
    : `✗ TOTAL: ${sum}, TXS: ${txs.length}`
  )
  console.log('')

  console.log('ERRORS')
  console.log('No available purchase:', noAvailablePurchases.length)
  console.log('No matching withdrawals:', noMatchingWithdrawals.length)
  console.log('Price errors:', priceErrors.length)
  console.log('')

  console.log('Like-Kind Exchanges', likeKindExchanges.length)
  console.log('Sales:', sales.length)
  console.log('Total Gains from Sales:', sales.map(sale => sale.buy - sale.cost).reduce((x,y) => x+y))
  console.log('')
}

})()
