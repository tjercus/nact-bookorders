#!/usr/bin/env node

const { start, dispatch, spawn, spawnStateless } = require("nact");
const { v4: uuidv4 } = require("uuid");
//

/**
 * naive way to create an ActorRef based on it's name (array with parts)
 * note that the system.name does not need to be included, only parent(s)
 */
const makeActorRefFromActorParts = (_system, parts) => ({
  system: _system,
  type: "actor", // assume type is not 'system' or something else
  path: { system: _system.name, parts },
});

/**
 * Send a message to a list of actors: ex:
 * [["parent-1", "child-1"], ["parent-2", "child-4"]]
 */
const dispatchToMultiple = (_system, arrayOfParts, msg) => {
  arrayOfParts.forEach((parts) => {
    const ref = makeActorRefFromActorParts(_system, parts);
    dispatch(ref, msg);
  });
};

const dispatchToOrderActor = (_system, ctx, msg, messageType) => {
  dispatch(
    makeActorRefFromActorParts(_system, [
      ctx.name, // "orderprocessor-x"
      `order-${msg.payload.orderId}`,
    ]),
    {
      payload: msg.payload,
      type: messageType,
    }
  );
};

//
const system = start();

const delay = (time) => new Promise((resolve) => setTimeout(resolve, time));

const MessageTypes = {
  ACCOUNT_CHARGED_EVT: "ACCOUNT_CHARGED_EVT",
  BOOK_SHIPPED_EVT: "BOOK_SHIPPED_EVT",
  CHARGE_CREDITCARD_CMD: "CHARGE_CREDITCARD_CMD",
  CREATE_ORDER_CMD: "CREATE_ORDER_CMD",
  ORDER_CREATED_EVT: "ORDER_CREATED_EVT",
  ORDER_BOOK_CMD: "ORDER_BOOK_CMD",
  SHIP_BOOK_CMD: "SHIP_BOOK_CMD",
};

const book1 = { isbn: 123, title: "how to act", author: "John", price: 12.3 };
const book2 = {
  isbn: 456,
  title: "ruling the universe",
  author: "Lord Vader",
  price: 19.99,
};
// factory method to create a customer/user
// he/she will start ordering the given book right away (for demo purposes)
const makeCustomerActor = (customerId = "customer-123", book) =>
  spawnStateless(
    system,
    async (msg, ctx) => {
      //console.log("CustomerActor ctx", ctx);
      // purchase a book
      dispatch(op1, {
        payload: { book, customerId },
        type: MessageTypes.ORDER_BOOK_CMD,
        sender: ctx.self,
      });
    },
    `customer-${customerId}`
  );

/**
 * Represents one order. Holds the different states the order is in
 * 'spawn' creates a statefull Actor
 */
const makeOrderActor = (parent = system, orderId = "123") =>
  spawn(
    parent,
    (state = { customerId: "", orderId, book: {}, stages: [] }, msg, ctx) => {
      console.log(`OrderActor ${orderId} reveived message`, msg);
      if (MessageTypes.CREATE_ORDER_CMD === msg.type) {
        dispatch(parent, {
          payload: msg.payload,
          sender: ctx.self,
          type: MessageTypes.ORDER_CREATED_EVT,
        });
      }
      // always store the incoming message in local state as a log
      const newState = {
        ...state,
        ...msg.payload,
        stages: [...state.stages].concat([
          { date: new Date(), event: msg.type },
        ]),
      };
      console.log("oa newState", newState);
      return newState;
    },
    `order-${orderId}`
  );

/**
 * Represents one way a customer can pay for an order
 */
const makeAccountActor = (parent = system, _orderId = "123") =>
  spawn(
    parent,
    (state = { customerId: "", orderId: _orderId, book: {} }, msg, ctx) => {
      if (MessageTypes.CHARGE_CREDITCARD_CMD) {
        // TODO create random failure to test error handling and retry
        setTimeout(() => {
          dispatch(parent, {
            payload: msg.payload,
            sender: ctx.self,
            type: MessageTypes.ACCOUNT_CHARGED_EVT,
          });
        }, Math.floor(Math.random() * 10) * 1000);
        return msg.payload; // place payload in the local state
      }
    },
    `account-${_orderId}`
  );

/**
 * Represents The One Inventory that holds all copies of all books
 */
const makeInventoryActor = (parent = system) =>
  spawn(
    parent,
    (state = { books: {} }, msg, ctx) => {
      if (MessageTypes.SHIP_BOOK_CMD) {
        // TODO create random failure to test error handling and retry
        dispatch(op1, {
          payload: msg.payload,
          sender: ctx.self,
          type: MessageTypes.BOOK_SHIPPED_EVT,
        });
        return msg.payload; // place payload in the local state
      }
    },
    `inventory`
  );

/**
 * Processor is the central nerve system of the order process.
 * Delegates commands and events to Actors
 */
const makeOrderProcessorActor = (id = "1") =>
  spawn(
    system,
    // no state for now ...
    (state = {}, msg, ctx) => {
      if (MessageTypes.ORDER_BOOK_CMD === msg.type) {
        // note that we spawn OrderActor as a child of OrderProcessorActor
        const orderId = uuidv4();
        const oa = makeOrderActor(ctx.self, orderId);
        dispatch(oa, {
          // payload is now { customerId, book, orderId }
          payload: { ...msg.payload, orderId },
          type: MessageTypes.CREATE_ORDER_CMD,
        });
      }
      if (MessageTypes.ORDER_CREATED_EVT === msg.type) {
        const aa = makeAccountActor(ctx.self, msg.payload.orderId);
        dispatch(aa, {
          payload: msg.payload,
          type: MessageTypes.CHARGE_CREDITCARD_CMD,
        });
        // also notify OrderActorX so he can update his state
        dispatchToOrderActor(system, ctx, msg, MessageTypes.ORDER_CREATED_EVT);
      }
      if (MessageTypes.ACCOUNT_CHARGED_EVT === msg.type) {
        const _ia1 = makeActorRefFromActorParts(system, ["inventory"]);
        dispatch(_ia1, {
          payload: msg.payload,
          type: MessageTypes.SHIP_BOOK_CMD,
        });

        // also notify OrderActorX so he can update his state
        dispatchToOrderActor(
          system,
          ctx,
          msg,
          MessageTypes.ACCOUNT_CHARGED_EVT
        );
      }
      if (MessageTypes.BOOK_SHIPPED_EVT === msg.type) {
        // also notify OrderActorX so he can update his state
        dispatchToOrderActor(system, ctx, msg, MessageTypes.BOOK_SHIPPED_EVT);
      }
    },
    `orderprocessor-${id}`
  );

/* ------------------- runtime ---------------- */

// TODO make an OrderProcessorProxyActor to delegate to 'one processor per order'
const op1 = makeOrderProcessorActor();
const ia1 = makeInventoryActor();

// one actor per customer
const c1 = makeCustomerActor("tjerk", book1);
const c2 = makeCustomerActor("luke", book2);

// customer receives an event and does not care which type it is, just places an order for a book
dispatch(c1, {});
dispatch(c2, {});
