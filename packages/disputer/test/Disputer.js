const { toWei, toBN, utf8ToHex, padRight, isAddress } = web3.utils;
const winston = require("winston");
const sinon = require("sinon");
const {
  PostWithdrawLiquidationRewardsStatusTranslations,
  LiquidationStatesEnum,
  MAX_UINT_VAL,
  interfaceName,
  ZERO_ADDRESS,
  runTestForVersion,
  createConstructorParamsForContractVersion,
  TESTED_CONTRACT_VERSIONS,
  TEST_DECIMAL_COMBOS,
  parseFixed,
  createContractObjectFromJson,
} = require("@uma/common");
const { getTruffleContract } = require("@uma/core");

// Script to test
const { Disputer } = require("../src/disputer.js");
const { ProxyTransactionWrapper } = require("../src/proxyTransactionWrapper");

// Helper clients and custom winston transport module to monitor winston log outputs
const {
  FinancialContractClient,
  GasEstimator,
  PriceFeedMock,
  SpyTransport,
  DSProxyManager,
} = require("@uma/financial-templates-lib");

let iterationTestVersion; // store the test version between tests that is currently being tested.
const startTime = "15798990420";
const unreachableDeadline = MAX_UINT_VAL;

// Common contract objects.
let collateralToken;
let financialContract;
let syntheticToken;
let mockOracle;
let store;
let timer;
let identifierWhitelist;
let finder;
let collateralWhitelist;
let optimisticOracle;
let configStore;
let constructorParams;
let multicall;

// Js Objects, clients and helpers
let spy;
let spyLogger;
let priceFeedMock;
let financialContractProps;
let disputerConfig;
let identifier;
let fundingRateIdentifier;
let convertDecimals;
let gasEstimator;
let financialContractClient;
let disputer;
let dsProxyManager;
let proxyTransactionWrapper;

// Set the funding rate and advances time by 10k seconds.
const _setFundingRateAndAdvanceTime = async (fundingRate) => {
  const currentTime = (await financialContract.getCurrentTime()).toNumber();
  await financialContract.proposeFundingRate({ rawValue: fundingRate }, currentTime);
  await financialContract.setCurrentTime(currentTime + 10000);
};

// If the current version being executed is part of the `supportedVersions` array then return `it` to run the test.
// Else, do nothing. Can be used exactly in place of a normal `it` to parameterize contract types and versions supported
// for a given test.eg: versionedIt([{ contractType: "any", contractVersion: "any" }])(["Perpetual-latest"])("test name", async function () { assert.isTrue(true) })
// Note that a second param can be provided to make the test an `it.only` thereby ONLY running that single test, on
// the provided version. This is very useful for debugging and writing single unit tests without having ro run all tests.
const versionedIt = function (supportedVersions, shouldBeItOnly = false) {
  if (shouldBeItOnly)
    return runTestForVersion(supportedVersions, TESTED_CONTRACT_VERSIONS, iterationTestVersion) ? it.only : () => {};
  return runTestForVersion(supportedVersions, TESTED_CONTRACT_VERSIONS, iterationTestVersion) ? it : () => {};
};

const Convert = (decimals) => (number) => (number ? parseFixed(number.toString(), decimals).toString() : number);

contract("Disputer.js", function (accounts) {
  const disputeBot = accounts[0];
  const sponsor1 = accounts[1];
  const sponsor2 = accounts[2];
  const sponsor3 = accounts[3];
  const liquidator = accounts[4];
  const contractCreator = accounts[5];
  const rando = accounts[6];

  TESTED_CONTRACT_VERSIONS.forEach(function (contractVersion) {
    // Store the contractVersion.contractVersion, type and version being tested
    iterationTestVersion = contractVersion;

    // Import the tested versions of contracts. note that financialContract is either an ExpiringMultiParty or a
    // Perpetual depending on the current iteration version.
    const FinancialContract = getTruffleContract(contractVersion.contractType, web3, contractVersion.contractVersion);
    const Finder = getTruffleContract("Finder", web3, contractVersion.contractVersion);
    const IdentifierWhitelist = getTruffleContract("IdentifierWhitelist", web3, contractVersion.contractVersion);
    const AddressWhitelist = getTruffleContract("AddressWhitelist", web3, contractVersion.contractVersion);
    const MockOracle = getTruffleContract("MockOracle", web3, contractVersion.contractVersion);
    const Token = getTruffleContract("ExpandedERC20", web3, contractVersion.contractVersion);
    const SyntheticToken = getTruffleContract("SyntheticToken", web3, contractVersion.contractVersion);
    const Timer = getTruffleContract("Timer", web3, contractVersion.contractVersion);
    const Store = getTruffleContract("Store", web3, contractVersion.contractVersion);
    const ConfigStore = getTruffleContract("ConfigStore", web3);
    const OptimisticOracle = getTruffleContract("OptimisticOracle", web3);
    const MulticallMock = getTruffleContract("MulticallMock", web3);

    for (let testConfig of TEST_DECIMAL_COMBOS) {
      describe(`${testConfig.collateralDecimals} collateral, ${testConfig.syntheticDecimals} synthetic & ${testConfig.priceFeedDecimals} pricefeed decimals, for smart contract version ${contractVersion.contractType} @ ${contractVersion.contractVersion}`, function () {
        before(async function () {
          identifier = `${testConfig.tokenName}TEST`;
          fundingRateIdentifier = `${testConfig.tokenName}_FUNDING`;
          convertDecimals = Convert(testConfig.collateralDecimals);

          collateralToken = await Token.new(
            testConfig.tokenSymbol + " Token", // Construct the token name.
            testConfig.tokenSymbol,
            testConfig.collateralDecimals,
            { from: contractCreator }
          );

          await collateralToken.addMember(1, contractCreator, { from: contractCreator });

          // Seed the accounts.
          await collateralToken.mint(sponsor1, convertDecimals("100000"), { from: contractCreator });
          await collateralToken.mint(sponsor2, convertDecimals("100000"), { from: contractCreator });
          await collateralToken.mint(sponsor3, convertDecimals("100000"), { from: contractCreator });
          await collateralToken.mint(liquidator, convertDecimals("100000"), { from: contractCreator });
          await collateralToken.mint(disputeBot, convertDecimals("100000"), { from: contractCreator });

          // Create identifier whitelist and register the price tracking ticker with it.
          identifierWhitelist = await IdentifierWhitelist.new();
          finder = await Finder.new();
          timer = await Timer.new();
          store = await Store.new({ rawValue: "0" }, { rawValue: "0" }, timer.address);
          await finder.changeImplementationAddress(utf8ToHex(interfaceName.Store), store.address);

          await finder.changeImplementationAddress(
            utf8ToHex(interfaceName.IdentifierWhitelist),
            identifierWhitelist.address
          );

          collateralWhitelist = await AddressWhitelist.new();
          await finder.changeImplementationAddress(
            utf8ToHex(interfaceName.CollateralWhitelist),
            collateralWhitelist.address
          );
          await collateralWhitelist.addToWhitelist(collateralToken.address);

          multicall = await MulticallMock.new();
        });
        beforeEach(async function () {
          await timer.setCurrentTime(startTime - 1);
          mockOracle = await MockOracle.new(finder.address, timer.address, { from: contractCreator });
          await finder.changeImplementationAddress(utf8ToHex(interfaceName.Oracle), mockOracle.address);

          // Create a new synthetic token
          syntheticToken = await SyntheticToken.new("Test Synthetic Token", "SYNTH", testConfig.syntheticDecimals);

          // If we are testing a perpetual then we need to also deploy a config store, an optimistic oracle and set the funding rate identifier.
          if (contractVersion.contractType == "Perpetual") {
            configStore = await ConfigStore.new(
              {
                timelockLiveness: 86400, // 1 day
                rewardRatePerSecond: { rawValue: "0" },
                proposerBondPercentage: { rawValue: "0" },
                maxFundingRate: { rawValue: toWei("0.00001") },
                minFundingRate: { rawValue: toWei("-0.00001") },
                proposalTimePastLimit: 0,
              },
              timer.address
            );

            await identifierWhitelist.addSupportedIdentifier(padRight(utf8ToHex(fundingRateIdentifier)));
            optimisticOracle = await OptimisticOracle.new(7200, finder.address, timer.address);
            await finder.changeImplementationAddress(
              utf8ToHex(interfaceName.OptimisticOracle),
              optimisticOracle.address
            );
          }

          constructorParams = await createConstructorParamsForContractVersion(
            contractVersion,
            {
              convertDecimals,
              finder,
              collateralToken,
              syntheticToken,
              identifier,
              fundingRateIdentifier,
              timer,
              store,
              configStore: configStore || {}, // if the contract type is not a perp this will be null.
            },
            { minSponsorTokens: { rawValue: convertDecimals("1") } } // these tests assume a min sponsor size of 1, not 5 as default
          );

          await identifierWhitelist.addSupportedIdentifier(constructorParams.priceFeedIdentifier, {
            from: accounts[0],
          });

          // Deploy a new expiring multi party OR perpetual, depending on what the financialContract has been set to.
          financialContract = await FinancialContract.new(constructorParams);
          // If we are testing a perpetual then we need to apply the initial funding rate to start the timer.
          await financialContract.setCurrentTime(startTime);
          await syntheticToken.addMinter(financialContract.address);
          await syntheticToken.addBurner(financialContract.address);

          // Generate Financial Contract properties to inform bot of important on-chain state values that we only want to query once.
          financialContractProps = { priceIdentifier: await financialContract.priceIdentifier() };

          await collateralToken.approve(financialContract.address, convertDecimals("100000000"), { from: sponsor1 });
          await collateralToken.approve(financialContract.address, convertDecimals("100000000"), { from: sponsor2 });
          await collateralToken.approve(financialContract.address, convertDecimals("100000000"), { from: sponsor3 });
          await collateralToken.approve(financialContract.address, convertDecimals("100000000"), { from: liquidator });
          await collateralToken.approve(financialContract.address, convertDecimals("100000000"), { from: disputeBot });

          syntheticToken = await Token.at(await financialContract.tokenCurrency());
          await syntheticToken.approve(financialContract.address, convertDecimals("100000000"), { from: sponsor1 });
          await syntheticToken.approve(financialContract.address, convertDecimals("100000000"), { from: sponsor2 });
          await syntheticToken.approve(financialContract.address, convertDecimals("100000000"), { from: sponsor3 });
          await syntheticToken.approve(financialContract.address, convertDecimals("100000000"), { from: liquidator });
          await syntheticToken.approve(financialContract.address, convertDecimals("100000000"), { from: disputeBot });

          spy = sinon.spy();

          spyLogger = winston.createLogger({
            level: "info",
            transports: [new SpyTransport({ level: "info" }, { spy: spy })],
          });

          // Create a new instance of the FinancialContractClient & GasEstimator to construct the disputer
          financialContractClient = new FinancialContractClient(
            spyLogger,
            FinancialContract.abi,
            web3,
            financialContract.address,
            multicall.address,
            testConfig.collateralDecimals,
            testConfig.syntheticDecimals,
            testConfig.priceFeedDecimals
          );
          gasEstimator = new GasEstimator(spyLogger);

          // Create a new instance of the disputer to test
          disputerConfig = {
            crThreshold: 0,
            disputeDelay: 0,
            contractType: contractVersion.contractType,
            contractVersion: contractVersion.contractVersion,
          };

          // Create price feed mock.
          priceFeedMock = new PriceFeedMock(undefined, undefined, undefined, undefined, testConfig.collateralDecimals);

          // Set the proxyTransaction wrapper to act without the DSProxy by setting useDsProxyToLiquidate to false.
          // This will treat all disputes in the "normal" way, executed from the bots's EOA.
          proxyTransactionWrapper = new ProxyTransactionWrapper({
            web3,
            financialContract: financialContract.contract,
            gasEstimator,
            account: accounts[0],
            dsProxyManager: null,
            useDsProxyToLiquidate: false,
            proxyTransactionWrapperConfig: {},
          });

          disputer = new Disputer({
            logger: spyLogger,
            financialContractClient,
            proxyTransactionWrapper,
            gasEstimator,
            priceFeed: priceFeedMock,
            account: accounts[0],
            financialContractProps,
            disputerConfig,
          });
        });

        versionedIt([{ contractType: "any", contractVersion: "any" }])(
          "Detect disputable positions and send disputes",
          async function () {
            // sponsor1 creates a position with 125 units of collateral, creating 100 synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("125") },
              { rawValue: convertDecimals("100") },
              { from: sponsor1 }
            );

            // sponsor2 creates a position with 150 units of collateral, creating 100 synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("150") },
              { rawValue: convertDecimals("100") },
              { from: sponsor2 }
            );

            // sponsor3 creates a position with 175 units of collateral, creating 100 synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("175") },
              { rawValue: convertDecimals("100") },
              { from: sponsor3 }
            );

            // The liquidator creates a position to have synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("1000") },
              { rawValue: convertDecimals("500") },
              { from: liquidator }
            );

            await financialContract.createLiquidation(
              sponsor1,
              { rawValue: "0" },
              { rawValue: toWei("1.75") },
              { rawValue: convertDecimals("100") },
              unreachableDeadline,
              { from: liquidator }
            );
            await financialContract.createLiquidation(
              sponsor2,
              { rawValue: "0" },
              { rawValue: toWei("1.75") },
              { rawValue: convertDecimals("100") },
              unreachableDeadline,
              { from: liquidator }
            );
            await financialContract.createLiquidation(
              sponsor3,
              { rawValue: "0" },
              { rawValue: toWei("1.75") },
              { rawValue: convertDecimals("100") },
              unreachableDeadline,
              { from: liquidator }
            );

            // Try disputing before any mocked prices are set, simulating a situation where the pricefeed
            // fails to return a price. The disputer should emit a "warn" level log about each missing prices.
            await disputer.update();
            const earliestLiquidationTime = Number(
              financialContractClient.getUndisputedLiquidations()[0].liquidationTime
            );
            priceFeedMock.setLastUpdateTime(earliestLiquidationTime);
            await disputer.dispute();
            assert.equal(spy.callCount, 3); // 3 warn level logs should be sent for 3 missing prices

            // Start with a mocked price of 1.75 usd per token.
            // This makes all sponsors undercollateralized, meaning no disputes are issued.
            priceFeedMock.setHistoricalPrice(toWei("1.75"));
            await disputer.update();
            await disputer.dispute();

            // There should be no liquidations created from any sponsor account
            assert.equal(
              (await financialContract.getLiquidations(sponsor1))[0].state,
              LiquidationStatesEnum.PRE_DISPUTE
            );
            assert.equal(
              (await financialContract.getLiquidations(sponsor2))[0].state,
              LiquidationStatesEnum.PRE_DISPUTE
            );
            assert.equal(
              (await financialContract.getLiquidations(sponsor3))[0].state,
              LiquidationStatesEnum.PRE_DISPUTE
            );
            assert.equal(spy.callCount, 3); // No info level logs should be sent.

            // With a price of 1.1, two sponsors should be correctly collateralized, so disputes should be issued against sponsor2 and sponsor3's liquidations.
            priceFeedMock.setHistoricalPrice(toWei("1.1"));

            // Disputing a timestamp that is before the pricefeed's lookback window will do nothing and print no warnings:
            // Set earliest timestamp to AFTER the liquidation:
            priceFeedMock.setLastUpdateTime(earliestLiquidationTime + 2);
            priceFeedMock.setLookback(1);
            await disputer.update();
            await disputer.dispute();
            // There should be no liquidations created from any sponsor account
            assert.equal(
              (await financialContract.getLiquidations(sponsor1))[0].state,
              LiquidationStatesEnum.PRE_DISPUTE
            );
            assert.equal(
              (await financialContract.getLiquidations(sponsor2))[0].state,
              LiquidationStatesEnum.PRE_DISPUTE
            );
            assert.equal(
              (await financialContract.getLiquidations(sponsor3))[0].state,
              LiquidationStatesEnum.PRE_DISPUTE
            );
            assert.equal(spy.callCount, 3); // No info level logs should be sent.

            // Now, set lookback such that the liquidation timestamp is captured and the dispute should go through.
            priceFeedMock.setLookback(2);
            await disputer.update();
            await disputer.dispute();
            assert.equal(spy.callCount, 5); // 2 info level logs should be sent at the conclusion of the disputes.

            // Sponsor2 and sponsor3 should be disputed.
            assert.equal(
              (await financialContract.getLiquidations(sponsor1))[0].state,
              LiquidationStatesEnum.PRE_DISPUTE
            );
            assert.equal(
              (await financialContract.getLiquidations(sponsor2))[0].state,
              LiquidationStatesEnum.PENDING_DISPUTE
            );
            assert.equal(
              (await financialContract.getLiquidations(sponsor3))[0].state,
              LiquidationStatesEnum.PENDING_DISPUTE
            );

            // The disputeBot should be the disputer in sponsor2 and sponsor3's liquidations.
            assert.equal((await financialContract.getLiquidations(sponsor2))[0].disputer, disputeBot);
            assert.equal((await financialContract.getLiquidations(sponsor3))[0].disputer, disputeBot);
          }
        );
        versionedIt([{ contractType: "any", contractVersion: "any" }])(
          "Detect disputable withdraws and send disputes",
          async function () {
            // sponsor1 creates a position with 125 units of collateral, creating 100 synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("125") },
              { rawValue: convertDecimals("100") },
              { from: sponsor1 }
            );

            // The liquidator creates a position to have synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("1000") },
              { rawValue: convertDecimals("500") },
              { from: liquidator }
            );

            // The sponsor1 submits a valid withdrawal request of withdrawing exactly 5e18 collateral. This places their
            // position at collateral of 120 and debt of 100. At a price of 1 unit per token they are exactly collateralized.

            await financialContract.requestWithdrawal({ rawValue: convertDecimals("5") }, { from: sponsor1 });

            await financialContract.createLiquidation(
              sponsor1,
              { rawValue: "0" },
              { rawValue: toWei("1.75") }, // Price high enough to initiate the liquidation
              { rawValue: convertDecimals("100") },
              unreachableDeadline,
              { from: liquidator }
            );

            // With a price of 1 usd per token this withdrawal was actually valid, even though it's very close to liquidation.
            // This makes all sponsors undercollateralized, meaning no disputes are issued.
            priceFeedMock.setHistoricalPrice(toWei("1"));
            await disputer.update();
            await disputer.dispute();
            assert.equal(spy.callCount, 1); // 1 info level logs should be sent at the conclusion of the disputes.

            // Sponsor1 should be disputed.
            assert.equal(
              (await financialContract.getLiquidations(sponsor1))[0].state,
              LiquidationStatesEnum.PENDING_DISPUTE
            );

            // The disputeBot should be the disputer in sponsor1  liquidations.
            assert.equal((await financialContract.getLiquidations(sponsor1))[0].disputer, disputeBot);

            // Push a price of 1, which should cause sponsor1's dispute to succeed as the position is correctly collateralized
            // at a price of 1.
            const liquidationTime = await financialContract.getCurrentTime();
            await mockOracle.pushPrice(web3.utils.utf8ToHex(identifier), liquidationTime, toWei("1"));

            await disputer.update();
            await disputer.withdrawRewards();
            assert.equal(spy.callCount, 2); // One additional info level event for the successful withdrawal.

            // sponsor1's dispute should be successful (valid withdrawal)
            // Note the check below has a bit of switching logic that is version specific to accommodate the change in withdrawal behaviour.
            assert.equal(
              (await financialContract.getLiquidations(sponsor1))[0].state,
              LiquidationStatesEnum.UNINITIALIZED
            );
          }
        );

        versionedIt([{ contractType: "any", contractVersion: "any" }])(
          "Withdraw from successful disputes",
          async function () {
            // sponsor1 creates a position with 150 units of collateral, creating 100 synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("150") },
              { rawValue: convertDecimals("100") },
              { from: sponsor1 }
            );

            // sponsor2 creates a position with 175 units of collateral, creating 100 synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("175") },
              { rawValue: convertDecimals("100") },
              { from: sponsor2 }
            );

            // The liquidator creates a position to have synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("1000") },
              { rawValue: convertDecimals("500") },
              { from: liquidator }
            );

            await financialContract.createLiquidation(
              sponsor1,
              { rawValue: "0" },
              { rawValue: toWei("1.75") },
              { rawValue: convertDecimals("100") },
              unreachableDeadline,
              { from: liquidator }
            );

            await financialContract.createLiquidation(
              sponsor2,
              { rawValue: "0" },
              { rawValue: toWei("1.75") },
              { rawValue: convertDecimals("100") },
              unreachableDeadline,
              { from: liquidator }
            );

            // With a price of 1.1, the sponsors should be correctly collateralized, so disputes should be issued against sponsor1 and sponsor2's liquidations.
            priceFeedMock.setHistoricalPrice(toWei("1.1"));
            await disputer.update();
            await disputer.dispute();
            assert.equal(spy.callCount, 2); // Two info level events for the two disputes.

            // Before the dispute is resolved, the bot should simulate the withdrawal, determine that it will fail, and
            // continue to wait.
            await disputer.update();
            await disputer.withdrawRewards();

            // No new info or error logs should appear because no attempted withdrawal should be made.
            assert.equal(spy.callCount, 2);

            // Push a price of 1.3, which should cause sponsor1's dispute to fail and sponsor2's dispute to succeed.
            const liquidationTime = await financialContract.getCurrentTime();
            await mockOracle.pushPrice(web3.utils.utf8ToHex(identifier), liquidationTime, toWei("1.3"));

            await disputer.update();
            await disputer.withdrawRewards();

            assert.equal(spy.callCount, 4);

            // sponsor1's dispute was unsuccessful, and the disputeBot should have called the withdraw method.The
            // dispute should still be seen as pending because the bot skipped the withdrawal.
            assert.equal((await financialContract.getLiquidations(sponsor1))[0].disputer, ZERO_ADDRESS);
            assert.equal(
              (await financialContract.getLiquidations(sponsor1))[0].state,
              LiquidationStatesEnum.UNINITIALIZED
            );

            // sponsor2's dispute was successful, and the disputeBot should've called the withdraw method.
            assert.equal((await financialContract.getLiquidations(sponsor2))[0].disputer, ZERO_ADDRESS);
            assert.equal(
              (await financialContract.getLiquidations(sponsor2))[0].state,
              LiquidationStatesEnum.UNINITIALIZED
            );

            // Check that the log includes a human readable translation of the liquidation status, and the dispute price.
            assert.equal(
              spy.getCall(-1).lastArg.liquidationResult.liquidationStatus,
              PostWithdrawLiquidationRewardsStatusTranslations[LiquidationStatesEnum.DISPUTE_SUCCEEDED]
            );
            assert.equal(spy.getCall(-1).lastArg.liquidationResult.settlementPrice, toWei("1.3"));

            // Check that the log contains the dispute rewards:
            if (disputer.isLegacyEmpVersion) {
              assert.isTrue(toBN(spy.getCall(-1).lastArg.liquidationResult.withdrawalAmount).gt(0));
            } else {
              assert.isTrue(toBN(spy.getCall(-1).lastArg.liquidationResult.paidToLiquidator).gt(0));
              assert.isTrue(toBN(spy.getCall(-1).lastArg.liquidationResult.paidToSponsor).gt(0));
              assert.isTrue(toBN(spy.getCall(-1).lastArg.liquidationResult.paidToDisputer).gt(0));
            }

            // After the dispute is resolved, the liquidation should still exist but the disputer should no longer be able to withdraw any rewards.
            await disputer.update();
            await disputer.withdrawRewards();
            assert.equal(spy.callCount, 4);
          }
        );

        versionedIt([{ contractType: "any", contractVersion: "any" }])("Too little collateral", async function () {
          // sponsor1 creates a position with 150 units of collateral, creating 100 synthetic tokens.
          await financialContract.create(
            { rawValue: convertDecimals("150") },
            { rawValue: convertDecimals("100") },
            { from: sponsor1 }
          );

          // sponsor2 creates a position with 1.75 units of collateral, creating 1 synthetic tokens.
          await financialContract.create(
            { rawValue: convertDecimals("1.75") },
            { rawValue: convertDecimals("1") },
            { from: sponsor2 }
          );

          // The liquidator creates a position to have synthetic tokens.
          await financialContract.create(
            { rawValue: convertDecimals("1000") },
            { rawValue: convertDecimals("500") },
            { from: liquidator }
          );

          await financialContract.createLiquidation(
            sponsor1,
            { rawValue: "0" },
            { rawValue: toWei("1.75") },
            { rawValue: convertDecimals("100") },
            unreachableDeadline,
            { from: liquidator }
          );

          await financialContract.createLiquidation(
            sponsor2,
            { rawValue: "0" },
            { rawValue: toWei("1.75") },
            { rawValue: convertDecimals("1") },
            unreachableDeadline,
            { from: liquidator }
          );

          // Send most of the user's balance elsewhere leaving only enough to dispute sponsor1's position.
          const transferAmount = (await collateralToken.balanceOf(disputeBot)).sub(toBN(convertDecimals("1")));
          await collateralToken.transfer(rando, transferAmount, { from: disputeBot });

          // Both positions should be disputed with a presumed price of 1.1, but will only have enough collateral for the smaller one.
          priceFeedMock.setHistoricalPrice(toWei("1.1"));
          await disputer.update();
          await disputer.dispute();
          assert.equal(spy.callCount, 2); // Two info events for the the 1 successful dispute and one for the failed dispute.

          // Only sponsor2 should be disputed.
          assert.equal((await financialContract.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PRE_DISPUTE);
          assert.equal(
            (await financialContract.getLiquidations(sponsor2))[0].state,
            LiquidationStatesEnum.PENDING_DISPUTE
          );

          // Transfer balance back, and the dispute should go through.
          await collateralToken.transfer(disputeBot, transferAmount, { from: rando });
          priceFeedMock.setHistoricalPrice(toWei("1.1"));
          await disputer.update();
          await disputer.dispute();
          assert.equal(spy.callCount, 3); // Info level event for the correctly processed dispute.

          // sponsor1 should now be disputed.
          assert.equal(
            (await financialContract.getLiquidations(sponsor1))[0].state,
            LiquidationStatesEnum.PENDING_DISPUTE
          );
        });

        describe("Overrides the default disputer configuration settings", function () {
          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Cannot set `crThreshold` >= 1",
            async function () {
              let errorThrown;
              try {
                disputerConfig = { ...disputerConfig, crThreshold: 1 };
                disputer = new Disputer({
                  logger: spyLogger,
                  financialContractClient,
                  proxyTransactionWrapper,
                  gasEstimator,
                  priceFeed: priceFeedMock,
                  account: accounts[0],
                  financialContractProps,
                  disputerConfig,
                });
                errorThrown = false;
              } catch (err) {
                errorThrown = true;
              }
              assert.isTrue(errorThrown);
            }
          );

          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Cannot set `crThreshold` < 0",
            async function () {
              let errorThrown;
              try {
                disputerConfig = { ...disputerConfig, crThreshold: -0.02 };
                disputer = new Disputer({
                  logger: spyLogger,
                  financialContractClient,
                  proxyTransactionWrapper,
                  gasEstimator,
                  priceFeed: priceFeedMock,
                  account: accounts[0],
                  financialContractProps,
                  disputerConfig,
                });
                errorThrown = false;
              } catch (err) {
                errorThrown = true;
              }
              assert.isTrue(errorThrown);
            }
          );

          versionedIt([{ contractType: "any", contractVersion: "any" }])("Sets `crThreshold` to 2%", async function () {
            disputerConfig = { ...disputerConfig, crThreshold: 0.02 };
            disputer = new Disputer({
              logger: spyLogger,
              financialContractClient,
              proxyTransactionWrapper,
              gasEstimator,
              priceFeed: priceFeedMock,
              account: accounts[0],
              financialContractProps,
              disputerConfig,
            });

            // sponsor1 creates a position with 115 units of collateral, creating 100 synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("115") },
              { rawValue: convertDecimals("100") },
              { from: sponsor1 }
            );

            // sponsor2 creates a position with 118 units of collateral, creating 100 synthetic tokens.
            await financialContract.create(
              { rawValue: convertDecimals("118") },
              { rawValue: convertDecimals("100") },
              { from: sponsor2 }
            );

            // liquidator creates a position to have synthetic tokens to pay off debt upon liquidation.
            await financialContract.create(
              { rawValue: convertDecimals("1000") },
              { rawValue: convertDecimals("500") },
              { from: liquidator }
            );

            // The liquidator liquidates sponsor1 at a price of 1.15 and sponsor2 at a price of 1.18. Now, assume
            // that the disputer sees a price of 0.95. The 2% buffer should lead the disputer to NOT dispute the
            // liquidation made at a price of 1.15, but should dispute the one made at 1.18.
            // Numerically: (tokens_outstanding * price * coltReq * (1+crThreshold) > debt)
            // must hold for correctly collateralized liquidations. If the price feed is 0.95 USD, then
            // there must be more than (100 * 0.95 * 1.2 * 1.02 = 116.28) collateral in the position. This means that
            // the price of 0.95 and the buffer of 2% leads the disputer to believe that sponsor1 is
            // undercollateralized and was correctly liquidated, while sponsor2 has enough collateral and should NOT
            // have been liquidated. Note that without the buffer of 2%, the required position collateral would be
            // (100 * 0.95 * 1.2 * 1 = 114), which would make both sponsors correctly collateralized and both
            // liquidations disputable.
            await financialContract.createLiquidation(
              sponsor1,
              { rawValue: "0" },
              { rawValue: toWei("1.15") },
              { rawValue: convertDecimals("100") },
              unreachableDeadline,
              { from: liquidator }
            );
            await financialContract.createLiquidation(
              sponsor2,
              { rawValue: "0" },
              { rawValue: toWei("1.18") },
              { rawValue: convertDecimals("100") },
              unreachableDeadline,
              { from: liquidator }
            );

            priceFeedMock.setHistoricalPrice(toWei("0.95"));
            await disputer.update();
            await disputer.dispute();

            assert.equal(spy.callCount, 1); // 1 info level events should be sent at the conclusion of the 1 dispute.

            // Sponsor1 should still be in a liquidation state.
            let liquidationObject = (await financialContract.getLiquidations(sponsor1))[0];
            assert.equal(liquidationObject.state, LiquidationStatesEnum.PRE_DISPUTE);

            // Sponsor2 should have been disputed.
            liquidationObject = (await financialContract.getLiquidations(sponsor2))[0];
            assert.equal(liquidationObject.state, LiquidationStatesEnum.PENDING_DISPUTE);
          });

          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Cannot set `disputeDelay` < 0",
            async function () {
              let errorThrown;
              try {
                disputerConfig = { ...disputerConfig, disputeDelay: -1 };
                disputer = new Disputer({
                  logger: spyLogger,
                  financialContractClient,
                  proxyTransactionWrapper,
                  gasEstimator,
                  priceFeed: priceFeedMock,
                  account: accounts[0],
                  financialContractProps,
                  disputerConfig,
                });
                errorThrown = false;
              } catch (err) {
                errorThrown = true;
              }
              assert.isTrue(errorThrown);
            }
          );

          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Sets `disputeDelay` to 60 seconds",
            async function () {
              disputerConfig = { ...disputerConfig, disputeDelay: 60 };
              disputer = new Disputer({
                logger: spyLogger,
                financialContractClient,
                proxyTransactionWrapper,
                gasEstimator,
                priceFeed: priceFeedMock,
                account: accounts[0],
                financialContractProps,
                disputerConfig,
              });

              // sponsor1 creates a position with 150 units of collateral, creating 100 synthetic tokens.
              await financialContract.create(
                { rawValue: convertDecimals("150") },
                { rawValue: convertDecimals("100") },
                { from: sponsor1 }
              );

              // The liquidator creates a position to have synthetic tokens.
              await financialContract.create(
                { rawValue: convertDecimals("1000") },
                { rawValue: convertDecimals("500") },
                { from: liquidator }
              );

              await financialContract.createLiquidation(
                sponsor1,
                { rawValue: "0" },
                { rawValue: toWei("1.75") },
                { rawValue: convertDecimals("100") },
                unreachableDeadline,
                { from: liquidator }
              );
              const liquidationTime = await financialContract.getCurrentTime();

              // With a price of 1.1, sponsor1 should be correctly collateralized, so a dispute should be issued. However,
              // not enough time has passed since the liquidation timestamp, so we'll delay disputing for now. The
              // `disputeDelay` configuration enforces that we must wait `disputeDelay` seconds after the liquidation
              // timestamp before disputing.
              priceFeedMock.setHistoricalPrice(toWei("1.1"));
              await disputer.update();
              await disputer.dispute();
              assert.equal(spy.callCount, 0);

              // Sponsor1 should not be disputed.
              assert.equal(
                (await financialContract.getLiquidations(sponsor1))[0].state,
                LiquidationStatesEnum.PRE_DISPUTE
              );

              // Advance contract time and attempt to dispute again.
              await financialContract.setCurrentTime(Number(liquidationTime) + disputerConfig.disputeDelay);

              priceFeedMock.setHistoricalPrice(toWei("1.1"));
              await disputer.update();
              await disputer.dispute();
              assert.equal(spy.callCount, 1);

              // The disputeBot should be the disputer in sponsor1's liquidations.
              assert.equal(
                (await financialContract.getLiquidations(sponsor1))[0].state,
                LiquidationStatesEnum.PENDING_DISPUTE
              );
              assert.equal((await financialContract.getLiquidations(sponsor1))[0].disputer, disputeBot);
            }
          );

          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Can provide an override price to disputer",
            async function () {
              // sponsor1 creates a position with 130 units of collateral, creating 100 synthetic tokens.
              await financialContract.create(
                { rawValue: convertDecimals("130") },
                { rawValue: convertDecimals("100") },
                { from: sponsor1 }
              );

              // The liquidator creates a position to have synthetic tokens.
              await financialContract.create(
                { rawValue: convertDecimals("1000") },
                { rawValue: convertDecimals("500") },
                { from: liquidator }
              );

              // The sponsor1 submits a valid withdrawal request of withdrawing 5e18 collateral. This places their
              // position at collateral of 125 and debt of 100.
              await financialContract.requestWithdrawal({ rawValue: convertDecimals("5") }, { from: sponsor1 });

              // Next, we will create an invalid liquidation to liquidate the whole position.
              await financialContract.createLiquidation(
                sponsor1,
                { rawValue: "0" },
                { rawValue: toWei("1.75") }, // Price high enough to initiate the liquidation
                { rawValue: convertDecimals("100") },
                unreachableDeadline,
                { from: liquidator }
              );

              // Say the price feed reports a price of 1 USD per token. This makes the liquidation invalid and the disputer should
              // dispute the liquidation: 125/(100*1.0)=1.25 CR -> Position was collateralized and invalid liquidation.
              priceFeedMock.setHistoricalPrice(toWei("1"));

              // However, say disputer operator has provided an override price of 1.2 USD per token. This makes the liquidation
              // valid and the disputer should do nothing: 125/(100*1.2)=1.0
              await disputer.update();
              const earliestLiquidationTime = Number(
                financialContractClient.getUndisputedLiquidations()[0].liquidationTime
              );
              priceFeedMock.setLastUpdateTime(earliestLiquidationTime);
              await disputer.dispute(toWei("1.2"));
              assert.equal(spy.callCount, 0); // 0 info level logs should be sent as no dispute.
              assert.equal(
                (await financialContract.getLiquidations(sponsor1))[0].state,
                LiquidationStatesEnum.PRE_DISPUTE
              );

              // Next assume that the override price is in fact 1 USD per token. At this price point the liquidation is now
              // invalid that the disputer should try dispute the tx. This should work even if the liquidation timestamp is
              // earlier than the price feed's earliest available timestamp:
              priceFeedMock.setLastUpdateTime(earliestLiquidationTime + 2);
              priceFeedMock.setLookback(1);
              await disputer.update();
              await disputer.dispute(toWei("1.0"));
              assert.equal(spy.callCount, 1); // 1 info level logs should be sent for the dispute
              assert.equal(
                (await financialContract.getLiquidations(sponsor1))[0].state,
                LiquidationStatesEnum.PENDING_DISPUTE
              );

              // The disputeBot should be the disputer in sponsor1  liquidations.
              assert.equal((await financialContract.getLiquidations(sponsor1))[0].disputer, disputeBot);
            }
          );
          describe("disputer correctly deals with funding rates from perpetual contract", () => {
            versionedIt([{ contractType: "Perpetual", contractVersion: "2.0.1" }])(
              "Can correctly detect invalid liquidations and dispute them",
              async function () {
                // sponsor1 creates a position with 125 units of collateral, creating 100 synthetic tokens.
                await financialContract.create(
                  { rawValue: convertDecimals("125") },
                  { rawValue: convertDecimals("100") },
                  { from: sponsor1 }
                );

                // sponsor2 creates a position with 150 units of collateral, creating 100 synthetic tokens.
                await financialContract.create(
                  { rawValue: convertDecimals("150") },
                  { rawValue: convertDecimals("100") },
                  { from: sponsor2 }
                );

                // sponsor3 creates a position with 175 units of collateral, creating 100 synthetic tokens.
                await financialContract.create(
                  { rawValue: convertDecimals("175") },
                  { rawValue: convertDecimals("100") },
                  { from: sponsor3 }
                );

                // liquidator creates a position with 2000 units of collateral, creating 1000 synthetic tokens for creating
                // liquidations.
                await financialContract.create(
                  { rawValue: convertDecimals("2000") },
                  { rawValue: convertDecimals("1000") },
                  { from: liquidator }
                );

                // Assume the current real token price is 1.1. This would place sponsor 1 at an undercollateralized CR
                // with 125/(100*1.1) = 1.136 (note no funding rate applied yet). If this sponsor is liquidated there
                // should be no dispute against them.

                // Liquidate the first sponsor.
                await financialContract.createLiquidation(
                  sponsor1,
                  { rawValue: "0" },
                  { rawValue: toWei("1.5") },
                  { rawValue: convertDecimals("100") },
                  unreachableDeadline,
                  { from: liquidator }
                );

                priceFeedMock.setHistoricalPrice(toWei("1.1"));
                await disputer.update();
                await disputer.dispute();
                assert.equal(spy.callCount, 0); // No info level logs should be sent as no dispute.

                // There should be exactly one liquidation in sponsor1's account.
                let liquidationObject = (await financialContract.getLiquidations(sponsor1))[0];
                assert.equal(liquidationObject.sponsor, sponsor1);
                assert.equal(liquidationObject.liquidator, liquidator);
                assert.equal(liquidationObject.state, LiquidationStatesEnum.PRE_DISPUTE);
                assert.equal(liquidationObject.liquidatedCollateral.rawValue, convertDecimals("125"));
                assert.equal(liquidationObject.lockedCollateral.rawValue, convertDecimals("125"));

                // The liquidation should NOT be disputed
                assert.equal(
                  (await financialContract.getLiquidations(sponsor1))[0].state,
                  LiquidationStatesEnum.PRE_DISPUTE
                );

                // No other sponsors should have been liquidated.
                assert.deepStrictEqual(await financialContract.getLiquidations(sponsor2), []);
                assert.deepStrictEqual(await financialContract.getLiquidations(sponsor3), []);

                // Next, introduce some funding rate. Setting the funding rate multiplier to 1.08, results in modifying
                // sponsor's debt. This becomes 100 * 1.08 = 108. After applying this funding rate sponsor 2 should
                // still be correctly capitalized with 150 / (100 * 1.08 * 1.1) = 1.262. This is above 1.25 CR.
                // However, let's assume that an invalid liquidator sees this position and tries to liquidate it (incorrectly).
                // The disputer bot should dispute this liquidation and save the day.

                await _setFundingRateAndAdvanceTime(toWei("0.000008"));
                await financialContract.applyFundingRate();
                assert.equal((await financialContract.fundingRate()).cumulativeMultiplier.toString(), toWei("1.08"));

                // Liquidate the second sponsor.
                await financialContract.createLiquidation(
                  sponsor2,
                  { rawValue: "0" },
                  { rawValue: toWei("1.5") },
                  { rawValue: convertDecimals("100") },
                  unreachableDeadline,
                  { from: liquidator }
                );
                const liquidation2Time = await financialContract.getCurrentTime();

                priceFeedMock.setHistoricalPrice(toWei("1.1"));
                await disputer.update();
                await disputer.dispute();
                assert.equal(spy.callCount, 1); // 1 info level logs should be sent for the dispute.

                // Sponsor 1 should be pre-dispute liquidation, sponsor 2 should be pending dispute and sponsor 3 should have nothing.
                assert.equal(
                  (await financialContract.getLiquidations(sponsor1))[0].state,
                  LiquidationStatesEnum.PRE_DISPUTE
                );
                liquidationObject = (await financialContract.getLiquidations(sponsor2))[0];
                assert.equal(liquidationObject.sponsor, sponsor2);
                assert.equal(liquidationObject.liquidator, liquidator);
                assert.equal(liquidationObject.disputer, disputeBot);
                assert.equal(liquidationObject.state, LiquidationStatesEnum.PENDING_DISPUTE);
                assert.equal(liquidationObject.liquidatedCollateral.rawValue, convertDecimals("150"));
                assert.equal(liquidationObject.lockedCollateral.rawValue, convertDecimals("150"));
                assert.deepStrictEqual(await financialContract.getLiquidations(sponsor3), []);

                // Next, we can test applying a large negative funding rate. Say we shift the funding rate by -0.1 two times.
                // this would work out to 1.08 * (1 - 0.00001 * 10000) * (1 - 0.00001 * 10000) = 0.8748. From this, token
                // sponsor debt has been decreased.
                await _setFundingRateAndAdvanceTime(toWei("-0.00001"));
                await financialContract.applyFundingRate();
                await _setFundingRateAndAdvanceTime(toWei("-0.00001"));
                await financialContract.applyFundingRate();
                assert.equal((await financialContract.fundingRate()).cumulativeMultiplier.toString(), toWei("0.8748"));

                // For the sake of this test let's assume that the liquidator is incorrectly configured and does not
                // consider the effects of funding rate in creating liquidations. With a set price of 1.5 the liquidation
                // "thinks" the CR is: 175 / (100 * 1.5) = 1.166 below CR (note no funding rate) but in actuality the "real"
                // CR is: 175 / (100 * 1.5*0.864) = 1.333 which is above CR, making the liquidation invalid (and disputable).

                // Liquidate the third sponsor.
                await financialContract.createLiquidation(
                  sponsor3,
                  { rawValue: "0" },
                  { rawValue: toWei("2") },
                  { rawValue: convertDecimals("100") },
                  unreachableDeadline,
                  { from: liquidator }
                );
                const liquidation3Time = await financialContract.getCurrentTime();

                priceFeedMock.setHistoricalPrice(toWei("1.5"));
                await disputer.update();
                await disputer.dispute();
                assert.equal(spy.callCount, 2); // 1 additional info log for the new dispute.

                liquidationObject = (await financialContract.getLiquidations(sponsor3))[0];
                assert.equal(liquidationObject.sponsor, sponsor3);
                assert.equal(liquidationObject.liquidator, liquidator);
                assert.equal(liquidationObject.disputer, disputeBot);
                assert.equal(liquidationObject.state, LiquidationStatesEnum.PENDING_DISPUTE);
                assert.equal(liquidationObject.liquidatedCollateral.rawValue, convertDecimals("175"));
                assert.equal(liquidationObject.lockedCollateral.rawValue, convertDecimals("175"));

                // Finally, Push prices into the mock oracle to enable the disputes to settle.
                await mockOracle.pushPrice(web3.utils.utf8ToHex(identifier), liquidation2Time, toWei("1.1"));
                await mockOracle.pushPrice(web3.utils.utf8ToHex(identifier), liquidation3Time, toWei("1.5"));

                // Now that the liquidation has expired, the disputer can withdraw rewards.
                const collateralPreWithdraw = await collateralToken.balanceOf(disputeBot);
                await disputer.update();
                await disputer.withdrawRewards();

                assert.equal(spy.callCount, 4); // 2 new info level events should be sent for withdrawing the two liquidations.

                // Disputer should have their collateral increased from the two rewards.
                const collateralPostWithdraw = await collateralToken.balanceOf(disputeBot);
                assert.isTrue(collateralPostWithdraw.gt(collateralPreWithdraw));

                // Liquidation data should have been deleted.
                assert.deepStrictEqual(
                  (await financialContract.getLiquidations(sponsor1))[0].state,
                  LiquidationStatesEnum.PRE_DISPUTE
                );
                assert.deepStrictEqual(
                  (await financialContract.getLiquidations(sponsor2))[0].state,
                  LiquidationStatesEnum.UNINITIALIZED
                );
                assert.deepStrictEqual(
                  (await financialContract.getLiquidations(sponsor3))[0].state,
                  LiquidationStatesEnum.UNINITIALIZED
                );
              }
            );
          });
        });
        describe("Dispute via DSProxy", () => {
          // Imports specific to the DSProxy wallet implementation.
          const DSProxyFactory = getTruffleContract("DSProxyFactory", web3);
          const DSProxy = getTruffleContract("DSProxy", web3);
          const UniswapV2Factory = require("@uniswap/v2-core/build/UniswapV2Factory.json");
          const IUniswapV2Pair = require("@uniswap/v2-core/build/IUniswapV2Pair.json");
          const UniswapV2Router02 = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");

          let reserveToken;
          let uniswapFactory;
          let uniswapRouter;
          let pairAddress;
          let pair;
          let dsProxyFactory;
          let dsProxy;

          beforeEach(async () => {
            // Create the reserve currency for the liquidator to hold.
            reserveToken = await Token.new("reserveToken", "DAI", 18, { from: contractCreator });
            await reserveToken.addMember(1, contractCreator, { from: contractCreator });

            // deploy Uniswap V2 Factory & router.
            uniswapFactory = await createContractObjectFromJson(UniswapV2Factory, web3).new(contractCreator, {
              from: contractCreator,
            });
            uniswapRouter = await createContractObjectFromJson(UniswapV2Router02, web3).new(
              uniswapFactory.address,
              collateralToken.address,
              { from: contractCreator }
            );

            // initialize the pair between the reserve and collateral token.
            await uniswapFactory.createPair(reserveToken.address, collateralToken.address, { from: contractCreator });
            pairAddress = await uniswapFactory.getPair(reserveToken.address, collateralToken.address);
            pair = await createContractObjectFromJson(IUniswapV2Pair, web3).at(pairAddress);

            // Seed the market. This sets up the initial price to be 1/1 reserve to collateral token. As the collateral
            // token is Dai this starts off the uniswap market at 1 reserve/collateral. Note the amount of collateral
            // is scaled according to the collateral decimals.
            await reserveToken.mint(pairAddress, toBN(toWei("1000")).muln(10000000), { from: contractCreator });
            await collateralToken.mint(pairAddress, toBN(convertDecimals("1000")).muln(10000000), {
              from: contractCreator,
            });
            await pair.sync({ from: contractCreator });

            dsProxyFactory = await DSProxyFactory.new({ from: contractCreator });

            // Create the DSProxy manager and proxy transaction wrapper for the liquidator instance.
            dsProxyManager = new DSProxyManager({
              logger: spyLogger,
              web3,
              gasEstimator,
              account: disputeBot,
              dsProxyFactoryAddress: dsProxyFactory.address,
              dsProxyFactoryAbi: DSProxyFactory.abi,
              dsProxyAbi: DSProxy.abi,
            });
            // Initialize the DSProxy manager. This will deploy a new DSProxy contract as the liquidator bot EOA does not
            // yet have one deployed.
            dsProxy = await DSProxy.at(await dsProxyManager.initializeDSProxy());

            proxyTransactionWrapper = new ProxyTransactionWrapper({
              web3,
              financialContract: financialContract.contract,
              gasEstimator,
              account: accounts[0],
              dsProxyManager,
              proxyTransactionWrapperConfig: {
                useDsProxyToDispute: true,
                uniswapRouterAddress: uniswapRouter.address,
                disputerReserveCurrencyAddress: reserveToken.address,
              },
            });

            disputer = new Disputer({
              logger: spyLogger,
              financialContractClient,
              proxyTransactionWrapper,
              gasEstimator,
              priceFeed: priceFeedMock,
              account: accounts[0],
              financialContractProps,
              disputerConfig,
            });
          });
          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Can correctly detect initialized DSProxy and ProxyTransactionWrapper",
            async function () {
              // The initialization in the before-each should be correct.
              assert.isTrue(isAddress(dsProxy.address));
              assert.equal(await dsProxy.owner(), disputeBot);
              assert.isTrue(disputer.proxyTransactionWrapper.useDsProxyToDispute);
              assert.equal(disputer.proxyTransactionWrapper.uniswapRouterAddress, uniswapRouter.address);
              assert.equal(disputer.proxyTransactionWrapper.dsProxyManager.getDSProxyAddress(), dsProxy.address);
              assert.equal(disputer.proxyTransactionWrapper.disputerReserveCurrencyAddress, reserveToken.address);
              assert.isTrue(spy.getCall(-1).lastArg.message.includes("DSProxy deployed for your EOA"));
            }
          );
          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Rejects invalid invocation of proxy transaction wrapper",
            async function () {
              // Invalid invocation should reject. Missing reserve currency.
              assert.throws(() => {
                new ProxyTransactionWrapper({
                  web3,
                  financialContract: financialContract.contract,
                  gasEstimator,
                  account: accounts[0],
                  dsProxyManager,
                  proxyTransactionWrapperConfig: {
                    useDsProxyToDispute: true,
                    uniswapRouterAddress: uniswapRouter.address,
                    disputerReserveCurrencyAddress: null,
                  },
                });
              });

              // Invalid invocation should reject. Missing reserve currency.
              assert.throws(() => {
                new ProxyTransactionWrapper({
                  web3,
                  financialContract: financialContract.contract,
                  gasEstimator,
                  account: accounts[0],
                  dsProxyManager,
                  proxyTransactionWrapperConfig: {
                    useDsProxyToDispute: true,
                    uniswapRouterAddress: "not-an-address",
                    disputerReserveCurrencyAddress: reserveToken.address,
                  },
                });
              });
              // Invalid invocation should reject. Requests to use DSProxy to Dispute but does not provide DSProxy manager.
              assert.throws(() => {
                new ProxyTransactionWrapper({
                  web3,
                  financialContract: financialContract.contract,
                  gasEstimator,
                  account: accounts[0],
                  dsProxyManager: null,
                  proxyTransactionWrapperConfig: {
                    useDsProxyToDispute: true,
                    uniswapRouterAddress: uniswapRouter.address,
                    disputerReserveCurrencyAddress: reserveToken.address,
                  },
                });
              });
              // Invalid invocation should reject. DSProxy Manager not yet initalized.
              dsProxyFactory = await DSProxyFactory.new({ from: contractCreator });

              dsProxyManager = new DSProxyManager({
                logger: spyLogger,
                web3,
                gasEstimator,
                account: disputeBot,
                dsProxyFactoryAddress: dsProxyFactory.address,
                dsProxyFactoryAbi: DSProxyFactory.abi,
                dsProxyAbi: DSProxy.abi,
              });
              assert.throws(() => {
                new ProxyTransactionWrapper({
                  web3,
                  financialContract: financialContract.contract,
                  gasEstimator,
                  account: accounts[0],
                  dsProxyManager,
                  proxyTransactionWrapperConfig: {
                    useDsProxyToDispute: true,
                    uniswapRouterAddress: uniswapRouter.address,
                    disputerReserveCurrencyAddress: reserveToken.address,
                  },
                });
              });
            }
          );
          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Correctly disputes positions using DSProxy",
            async function () {
              // Seed the dsProxy with some reserve tokens so it can buy collateral to execute the dispute.
              await reserveToken.mint(dsProxy.address, toWei("10000"), { from: contractCreator });

              // Create three positions for each sponsor and one for the liquidator. Liquidate all positions.
              await financialContract.create(
                { rawValue: convertDecimals("125") },
                { rawValue: convertDecimals("100") },
                { from: sponsor1 }
              );

              await financialContract.create(
                { rawValue: convertDecimals("150") },
                { rawValue: convertDecimals("100") },
                { from: sponsor2 }
              );

              await financialContract.create(
                { rawValue: convertDecimals("175") },
                { rawValue: convertDecimals("100") },
                { from: sponsor3 }
              );

              await financialContract.create(
                { rawValue: convertDecimals("1000") },
                { rawValue: convertDecimals("500") },
                { from: liquidator }
              );

              await financialContract.createLiquidation(
                sponsor1,
                { rawValue: "0" },
                { rawValue: toWei("1.75") },
                { rawValue: convertDecimals("100") },
                unreachableDeadline,
                { from: liquidator }
              );
              await financialContract.createLiquidation(
                sponsor2,
                { rawValue: "0" },
                { rawValue: toWei("1.75") },
                { rawValue: convertDecimals("100") },
                unreachableDeadline,
                { from: liquidator }
              );
              await financialContract.createLiquidation(
                sponsor3,
                { rawValue: "0" },
                { rawValue: toWei("1.75") },
                { rawValue: convertDecimals("100") },
                unreachableDeadline,
                { from: liquidator }
              );

              // Start with a mocked price of 1.75 usd per token.
              // This makes all sponsors undercollateralized, meaning no disputes are issued.
              priceFeedMock.setHistoricalPrice(toWei("1.75"));
              await disputer.update();
              await disputer.dispute();

              // There should be no disputes created from any sponsor account
              assert.equal(
                (await financialContract.getLiquidations(sponsor1))[0].state,
                LiquidationStatesEnum.PRE_DISPUTE
              );
              assert.equal(
                (await financialContract.getLiquidations(sponsor2))[0].state,
                LiquidationStatesEnum.PRE_DISPUTE
              );
              assert.equal(
                (await financialContract.getLiquidations(sponsor3))[0].state,
                LiquidationStatesEnum.PRE_DISPUTE
              );
              assert.equal(spy.callCount, 1); // No info level logs should be sent.

              // With a price of 1.1, two sponsors should be correctly collateralized, so disputes should be issued against sponsor2 and sponsor3's liquidations.
              priceFeedMock.setHistoricalPrice(toWei("1.1"));

              // Set lookback such that the liquidation timestamp is captured and the dispute should go through.
              priceFeedMock.setLookback(2);
              await disputer.update();
              await disputer.dispute();
              assert.equal(spy.callCount, 5); // info level logs should be sent at the conclusion of the disputes.

              // Sponsor2 and sponsor3 should be disputed.
              assert.equal(
                (await financialContract.getLiquidations(sponsor1))[0].state,
                LiquidationStatesEnum.PRE_DISPUTE
              );
              assert.equal(
                (await financialContract.getLiquidations(sponsor2))[0].state,
                LiquidationStatesEnum.PENDING_DISPUTE
              );
              assert.equal(
                (await financialContract.getLiquidations(sponsor3))[0].state,
                LiquidationStatesEnum.PENDING_DISPUTE
              );

              // The dsProxy should be the disputer in sponsor2 and sponsor3's liquidations.
              assert.equal((await financialContract.getLiquidations(sponsor2))[0].disputer, dsProxy.address);
              assert.equal((await financialContract.getLiquidations(sponsor3))[0].disputer, dsProxy.address);

              // Push a price of 1.1, which should cause the two disputes to be correct (invalid liquidations)
              const liquidationTime = await financialContract.getCurrentTime();
              await mockOracle.pushPrice(web3.utils.utf8ToHex(identifier), liquidationTime, toWei("1.1"));

              // rewards should be withdrawn and the DSProxy collateral balance should increase.

              const dsProxyCollateralBalanceBefore = await collateralToken.balanceOf(dsProxy.address);

              await disputer.update();
              await disputer.withdrawRewards();
              assert.equal(spy.callCount, 7); // two new info after withdrawing the two disputes.

              const dsProxyCollateralBalanceAfter = await collateralToken.balanceOf(dsProxy.address);
              assert.isTrue(dsProxyCollateralBalanceAfter.gt(dsProxyCollateralBalanceBefore));

              // Pre-dispute as nothing should have change and rewards by liquidator are not withdrawn.
              assert.equal(
                (await financialContract.getLiquidations(sponsor1))[0].state,
                LiquidationStatesEnum.PRE_DISPUTE
              );

              // Uninitialized as reward withdrawal deletes the liquidation object.
              assert.equal(
                (await financialContract.getLiquidations(sponsor2))[0].state,
                LiquidationStatesEnum.UNINITIALIZED
              );
              assert.equal(
                (await financialContract.getLiquidations(sponsor3))[0].state,
                LiquidationStatesEnum.UNINITIALIZED
              );
            }
          );
          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Correctly deals with reserve being the same as collateral currency using DSProxy",
            async function () {
              // Create a new disputer set to use the same collateral as the reserve currency.
              proxyTransactionWrapper = new ProxyTransactionWrapper({
                web3,
                financialContract: financialContract.contract,
                gasEstimator,
                account: accounts[0],
                dsProxyManager,
                proxyTransactionWrapperConfig: {
                  useDsProxyToDispute: true,
                  uniswapRouterAddress: uniswapRouter.address,
                  disputerReserveCurrencyAddress: collateralToken.address,
                },
              });

              disputer = new Disputer({
                logger: spyLogger,
                financialContractClient,
                proxyTransactionWrapper,
                gasEstimator,
                priceFeed: priceFeedMock,
                account: accounts[0],
                financialContractProps,
                disputerConfig,
              });

              // Seed the dsProxy with some reserve tokens so it can buy collateral to execute the dispute.
              await collateralToken.mint(dsProxy.address, toWei("10000"), { from: contractCreator });

              // Create 1 positions for the first sponsor sponsor and one for the liquidator. Liquidate the position.
              await financialContract.create(
                { rawValue: convertDecimals("150") },
                { rawValue: convertDecimals("100") },
                { from: sponsor1 }
              );

              await financialContract.create(
                { rawValue: convertDecimals("1000") },
                { rawValue: convertDecimals("500") },
                { from: liquidator }
              );

              await financialContract.createLiquidation(
                sponsor1,
                { rawValue: "0" },
                { rawValue: toWei("1.75") },
                { rawValue: convertDecimals("100") },
                unreachableDeadline,
                { from: liquidator }
              );

              // With a price of 1.1, the sponsors should be correctly collateralized, so a dispute should be issued against sponsor1.
              priceFeedMock.setHistoricalPrice(toWei("1.1"));

              // Seed the dsProxy with some reserve tokens so it can buy collateral to execute the dispute.
              await reserveToken.mint(dsProxy.address, toWei("10000"), { from: contractCreator });

              // Set lookback such that the liquidation timestamp is captured and the dispute should go through.
              priceFeedMock.setLookback(2);
              await disputer.update();
              await disputer.dispute();

              // Sponsor1 and  should be disputed.
              assert.equal(
                (await financialContract.getLiquidations(sponsor1))[0].state,
                LiquidationStatesEnum.PENDING_DISPUTE
              );

              // The dsProxy should be the disputer in sponsor1 liquidations.
              assert.equal((await financialContract.getLiquidations(sponsor1))[0].disputer, dsProxy.address);

              // There should be no swap events as the DSProxy already had enough collateral to dispute
              assert.equal((await pair.getPastEvents("Swap")).length, 0);
            }
          );
          versionedIt([{ contractType: "any", contractVersion: "any" }])(
            "Correctly respects existing collateral balances when using DSProxy",
            async function () {
              // Seed the dsProxy with a few collateral but not enough to finish the dispute. All collateral available
              // should be spent and the shortfall should be purchased.
              await collateralToken.mint(dsProxy.address, convertDecimals("0.5"), { from: contractCreator });
              await reserveToken.mint(dsProxy.address, toWei("10000"), { from: contractCreator });

              // Set the final fee to 1 unit collateral. The total collateral needed for the dispute will be final fee + dispute bond.
              await store.setFinalFee(collateralToken.address, { rawValue: convertDecimals("1") });

              // Create 1 positions for the first sponsor sponsor and one for the liquidator. Liquidate the position.
              await financialContract.create(
                { rawValue: convertDecimals("150") },
                { rawValue: convertDecimals("100") },
                { from: sponsor1 }
              );

              await financialContract.create(
                { rawValue: convertDecimals("1000") },
                { rawValue: convertDecimals("500") },
                { from: liquidator }
              );

              await financialContract.createLiquidation(
                sponsor1,
                { rawValue: "0" },
                { rawValue: toWei("1.75") },
                { rawValue: convertDecimals("100") },
                unreachableDeadline,
                { from: liquidator }
              );

              // With a price of 1.1, the sponsors should be correctly collateralized, so a dispute should be issued against sponsor1.
              priceFeedMock.setHistoricalPrice(toWei("1.1"));

              // Set lookback such that the liquidation timestamp is captured and the dispute should go through.
              priceFeedMock.setLookback(2);
              await disputer.update();
              await disputer.dispute();

              // Sponsor1 and  should be disputed.
              assert.equal(
                (await financialContract.getLiquidations(sponsor1))[0].state,
                LiquidationStatesEnum.PENDING_DISPUTE
              );

              // The dsProxy should be the disputer in sponsor1 liquidations.
              assert.equal((await financialContract.getLiquidations(sponsor1))[0].disputer, dsProxy.address);

              // There should be 1 swap events as the DSProxy had to buy the token shortfall in collateral.
              assert.equal((await pair.getPastEvents("Swap")).length, 1);

              // There should be no collateral left as it was all used in the dispute.
              assert.equal((await collateralToken.balanceOf(dsProxy.address)).toString(), "0");
            }
          );
        });
      });
    }
  });
});
