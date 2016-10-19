// Copyright (c) 2012 Matt Weagle (mweagle@gmail.com)

// Permission is hereby granted, free of charge, to
// any person obtaining a copy of this software and
// associated documentation files (the "Software"),
// to deal in the Software without restriction,
// including without limitation the rights to use,
// copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so,
// subject to the following conditions:

// The above copyright notice and this permission
// notice shall be included in all copies or substantial
// portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
// ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
// TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
// PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
// SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
// CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
// IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE

var util = require( 'util' );

/*****************************************************************************/
// Privates
/*****************************************************************************/

/**
 * CircuitBreaker states
 * @type {Object} Valid CircuitBreaker states
 */
const STATE = {
    CLOSED   : 'closed',
    OPEN     : 'open',
    HALF_OPEN: 'half_open'
};

/**
 * Return a time value (in MS) that is either the
 * process.hrtime() value, or if optional_base_ms_time
 * is provided, the delta between the two measurements.
 * @param  {Number} optional_base_ms_time Optional base time to use for
 *                                        delta time.
 * @return {Number}                       Time or duration, in MS
 */
var _ms_value = ( optional_base_ms_time ) => {
    let now_time = process.hrtime();
    let ts = Math.floor( (now_time[ 0 ] * 1000) + (now_time[ 1 ] / 1000000) );
    return (optional_base_ms_time ? (ts - optional_base_ms_time) : ts);
};

/*****************************************************************************/
// Custom Error
/*****************************************************************************/
class CustomError extends Error {
    constructor( message ) {
        super( message );
        this.name = this.constructor.name;
        this.message = message;
        if ( typeof Error.captureStackTrace === 'function' ) {
            Error.captureStackTrace( this, this.constructor );
        }
        else {
            this.stack = (new Error( message )).stack;
        }
    }
}

/*****************************************************************************/
// TimeoutError
/*****************************************************************************/
class TimeoutError extends CustomError {
    constructor( fn_name, duration ) {
        super( util.format( `Function ${fn_name} timed out after: ${duration} ms` ) );
        this._name = 'Timeout Error';
    }

    name() {
        return this._name;
    }
}

/*****************************************************************************/
// CircuitBreakerError
/*****************************************************************************/
class CircuitBreakerError extends CustomError {
    constructor( fn_name ) {
        super( util.format( `Function ${fn_name} failed-fast due to circuit-breaker OPEN'` ) );
        this._name = 'CircuitBreaker Error';
    }

    name() {
        return this._name;
    }
}

/*****************************************************************************/
// CircuitBreaker
/*****************************************************************************/
/**
 * CircuitBreaker instance that gates access to underlying functions.
 * @param {Object/Function} object_or_function Either an Object whose enumerable
 *                                             functions should be grouped together
 *                                             behind a single CircuitBreaker, or
 *                                             a free function with the same behavior.
 * @param {Number} max_failures       Maximum number of failures before breaker
 *                                    transitions to the OPEN state.
 * @param {Number} call_timeout_ms    Function call timeout.  Functions
 *                                    that take longer than this value (in MS) are
 *                                    considered to have failed.
 * @param {Number} reset_timeout_ms    Duration (in MS) that must elapse before a
 *                                    breaker in the OPEN state transitions to the
 *                                    HALF_OPEN state.
 */
class CircuitBreaker {
    constructor( object_or_function, max_failures, call_timeout_ms, reset_timeout_ms ) {
        this._object_or_function = object_or_function;
        this._gated_max_failures = max_failures;
        this._gated_call_timeout_ms = call_timeout_ms;
        this._gated_reset_timeout_ms = reset_timeout_ms;
        this._failure_counter = 0;
        this._breaker_state = STATE.CLOSED;
        this._last_call_time = null;
    }

    get _gated_failure_counter() {
        return this._failure_counter;
    }

    set _gated_failure_counter( new_value ) {
        this._failure_counter = new_value;
    }

    get _gated_breaker_state() {
        return this._breaker_state;
    }

    set _gated_breaker_state( new_state ) {
        this._breaker_state = new_state;
    }

    get _gated_last_call_time() {
        return this._last_call_time;
    }

    set _gated_last_call_time( new_call_time ) {
        this._last_call_time = new_call_time;
    }

    initialize() {
        ///////////////////////////////////////////////////////////////////////////
        //
        // Tap the functions that we're supposed to circuit-break on
        //
        if ( typeof(this._object_or_function) === 'function' ) {
            this._gate_function( null, 'call', this._object_or_function );
        }
        else {
            Object.keys( this._object_or_function ).forEach( function ( eachKey ) {
                var object_value = this._object_or_function[ eachKey ];
                if ( typeof(object_value) === 'function' ) {
                    this._gate_function( this._object_or_function, eachKey, object_value );
                }
            } );
        }
    }

    _gate_function( this_ptr, fn_name, fn_impl ) {
        this[ fn_name ] = ( /* arguments*, callback */ ) => {
            let call_timeout_id = null;
            let callback_invoked = false;

            // This is the tapped callback that will update the
            // circuit breaker before passing the results onto the
            // target_callback
            let tapped_callback = ( error, results ) => {
                if ( !callback_invoked ) {
                    callback_invoked = true;
                    clearTimeout( call_timeout_id );
                    if ( !error ) {
                        this._gated_breaker_state = STATE.CLOSED;
                        this._gated_failure_counter = 0;
                    }
                    else {
                        this._gated_failure_counter = (self._gated_failure_counter + 1);
                        this._gated_breaker_state = (self._gated_failure_counter >= self._gated_max_failures) ? STATE.OPEN : STATE.CLOSED;

                        // If we're open, set a timeout so that we can update our
                        // state to half-open after the configured timeout.  Once this is
                        // triggered, the next call will be executed to see
                        // if the service is back online...
                        if ( self._gated_breaker_state === STATE.OPEN ) {
                            setTimeout( function onHalfOpen() {
                                    self._gated_breaker_state = STATE.HALF_OPEN;
                                },
                                self._gated_reset_timeout_ms );
                        }
                    }
                    // Pass it on...
                    target_callback.call( this_ptr, error, results );
                }
                else {
                    // NOP - callback already executed
                }
            };

            // Get the arguments, swapping our tapped callback for the
            // supplied one.
            // This automatic aliasing requires that the target function
            // has the signature:
            //  fn(args*, callback)
            //
            let tapped_arguments = Array.prototype.slice.call( arguments );
            let target_callback = tapped_arguments.pop();

            // Hard to gate if we don't know where to go...
            if ( typeof(target_callback) !== 'function' ) {
                throw new Error( 'circuit-breaker functions must have signatures where the last argument is callback(e, result)' );
            }
            // Push our tapped_callback onto the argument
            // array so we can manage the circuit breaker
            tapped_arguments.push( tapped_callback );

            /////////////////////////////////////////////////////////////////////////
            //
            // Call the function, failing immediately if we're in
            // an unsupported call state
            //
            let call_function = (this._gated_breaker_state !== STATE.OPEN);

            // Guard so that only first call attempt after reset timeout has triggered
            if ( self._gated_breaker_state === STATE.HALF_OPEN ) {
                self._gated_breaker_state = STATE.OPEN;
            }

            /////////////////////////////////////////////////////////////////////////
            // At this point we're either going to call or fail fast
            if ( call_function ) {
                let call_time = _ms_value();
                this._gated_last_call_time = call_time;
                call_timeout_id = setTimeout( function onTimeout() {
                        var error = new TimeoutError( fn_name, _ms_value( call_time ) );
                        tapped_callback( error, null );
                    },
                    this._gated_call_timeout_ms );
                fn_impl.apply( this_ptr, tapped_arguments );
            }
            else {
                setImmediate( target_callback, new CircuitBreakerError( fn_name ), null );
            }
        };
    }
}

/*****************************************************************************/
// Exports
/*****************************************************************************/
module.exports.new_circuit_breaker = ( object_or_function, max_failures, call_timeout_ms, reset_timeout_ms ) => {
    var breaker = new CircuitBreaker( object_or_function, max_failures, call_timeout_ms, reset_timeout_ms );
    return ((typeof(object_or_function) === 'function') ? breaker.call : breaker);
};

module.exports.TimeoutError = TimeoutError;
module.exports.CircuitBreakerError = CircuitBreakerError;