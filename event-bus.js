const EventEmitter = require('events');
const db = require('./database.js'); //for logging events

// --- (Optional) Schema Validation Dependencies ---
// Uncomment these lines to enable schema validation.
// const Ajv = require("ajv");
// const eventSchemas = require("./event-schemas"); 
// const ajv = new Ajv();

/**
 * @class EventBusWrapper
 * @description A decorator for Node's native EventEmitter that enhances it with
 *              additional capabilities, such as schema validation for event payloads.
 *              This class uses the Proxy pattern to intercept method calls to the
 *              underlying EventEmitter instance without modifying its original behavior.
 */
class EventBusWrapper {
  constructor(eventEmitterInstance) {
    this.eventBus = eventEmitterInstance;

    // The Proxy intercepts any property access on the EventBusWrapper instance.
    return new Proxy(this, {
      /**
       * The 'get' trap is triggered whenever a property is accessed.
       * @param {EventBusWrapper} target - The original EventBusWrapper instance.
       * @param {string} prop - The name of the property being accessed (e.g., 'on', 'emit').
       */
      get: (target, prop) => {
        // If the property exists on our wrapper (e.g., custom methods or propierties), use it.
        if (prop in target) {
          return target[prop];
        }

        // Otherwise, delegate the call to the original EventEmitter instance.
        const originalMethod = target.eventBus[prop];

        // --- ENHANCEMENT: Intercept the 'emit' method ---
        if (prop === 'emit') {
          // We return a new function that wraps the original 'emit'.
          // This allows us to inject our validation logic before the event is published.
          return (eventType, eventPayload) => {
            
            // --- SCHEMA VALIDATION LOGIC (currently commented out) ---
            // This is where the schema validation would be enforced. It ensures that
            // every event published to the bus conforms to a predefined structure,
            // preventing bugs caused by malformed event data.
            /*
            const validate = eventSchemas[eventType] && ajv.compile(eventSchemas[eventType]);
            if (validate && !validate(eventPayload)) {
              const errorMessage = `Invalid event payload for '${eventType}'. Validation errors: ${ajv.errorsText(validate.errors)}`;
              console.error('[EventBus] Schema validation failed:', errorMessage);
              // In a production environment, you might throw an error or emit a dedicated 'schema-error' event.
              throw new Error(errorMessage);
            }
            */

            // Log the event without awaiting ("fire-and-forget") to prevent delaying the main flow.
            // For critical auditing, a more robust solution with a queue and retry logic
            // should be implemented to handle potential database failures.
            db.logEvent(eventType, eventPayload)
              .catch(err => console.error('[EventBus] Failed to log event to database:', err));

            // After validation (if enabled), call the original 'emit' method.
            // .call() is used to ensure the correct `this` context for the EventEmitter.
            return originalMethod.call(target.eventBus, eventType, eventPayload);
          };
        }
        
        // For any other method (like 'on', 'once', etc.), we need to ensure the `this` context is correct.
        // If the property is a function, we bind it to the original EventEmitter instance.
        if (typeof originalMethod === 'function') {
            return originalMethod.bind(target.eventBus);
        }

        // If it's not a function, just return the property.
        return originalMethod;
      },
    });
  }
}

// Create a single, shared instance of the EventEmitter.
const nativeEventEmitter = new EventEmitter();

// Wrap the native instance with our enhanced proxy.
// The rest of the application will interact with this `eventBus` instance,
// benefiting from any enhancements (like validation) transparently.
const eventBus = new EventBusWrapper(nativeEventEmitter);

console.log('[EventBus] The central, enhanced event bus has been created.');

module.exports = eventBus;