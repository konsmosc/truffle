import debugModule from "debug";
const debug = debugModule("codec:decode:value");

import read from "../read";
import * as CodecUtils from "truffle-codec-utils";
import { Types, Values } from "truffle-codec-utils";
import BN from "bn.js";
import { DataPointer } from "../types/pointer";
import { EvmInfo, DecoderMode } from "../types/evm";
import { DecoderRequest, GeneratorJunk } from "../types/request";
import { StopDecodingError } from "../types/errors";

export default function* decodeValue(dataType: Types.Type, pointer: DataPointer, info: EvmInfo, mode: DecoderMode = "normal"): IterableIterator<Values.Result | DecoderRequest | GeneratorJunk> {
  //NOTE: this does not actually return a Uint8Aarray, but due to the use of yield* read,
  //we have to include it in the type :-/
  const { state } = info;
  const permissivePadding = mode === "permissive";
  const strict = mode === "strict";

  let bytes: Uint8Array;
  try {
    bytes = yield* read(pointer, state);
  }
  catch(error) { //error: Values.DecodingError
    debug("segfault, pointer %o, state: %O", pointer, state);
    if(strict) {
      throw new StopDecodingError();
    }
    return Values.makeGenericErrorResult(dataType, error.error);
  }

  debug("type %O", dataType);
  debug("pointer %o", pointer);

  switch(dataType.typeClass) {

    case "bool": {
      if(!checkPaddingLeft(bytes, 1)) {
        if(strict) {
          throw new StopDecodingError();
        }
        return new Values.BoolErrorResult(
          dataType,
          new Values.BoolPaddingError(CodecUtils.Conversion.toHexString(bytes))
        );
      }
      const numeric = CodecUtils.Conversion.toBN(bytes);
      if(numeric.eqn(0)) {
        return new Values.BoolValue(dataType, false);
      }
      else if(numeric.eqn(1)) {
        return new Values.BoolValue(dataType, true);
      }
      else {
        if(strict) {
          throw new StopDecodingError();
        }
        return new Values.BoolErrorResult(
          dataType,
          new Values.BoolOutOfRangeError(numeric)
        );
      }
    }

    case "uint":
      //first, check padding (if needed)
      if(!permissivePadding && !checkPaddingLeft(bytes, dataType.bits/8)) {
        if(strict) {
          throw new StopDecodingError();
        }
        return new Values.UintErrorResult(
          dataType,
          new Values.UintPaddingError(CodecUtils.Conversion.toHexString(bytes))
        );
      }
      //now, truncate to appropriate length (keeping the bytes on the right)
      bytes = bytes.slice(-dataType.bits/8);
      return new Values.UintValue(dataType, CodecUtils.Conversion.toBN(bytes));
    case "int":
      //first, check padding (if needed)
      if(!permissivePadding && !checkPaddingSigned(bytes, dataType.bits/8)) {
        if(strict) {
          throw new StopDecodingError();
        }
        return new Values.IntErrorResult(
          dataType,
          new Values.IntPaddingError(CodecUtils.Conversion.toHexString(bytes))
        );
      }
      //now, truncate to appropriate length (keeping the bytes on the right)
      bytes = bytes.slice(-dataType.bits/8);
      return new Values.IntValue(dataType, CodecUtils.Conversion.toSignedBN(bytes));

    case "address":
      if(!permissivePadding && !checkPaddingLeft(bytes, CodecUtils.EVM.ADDRESS_SIZE)) {
        if(strict) {
          throw new StopDecodingError();
        }
        return new Values.AddressErrorResult(
          dataType,
          new Values.AddressPaddingError(CodecUtils.Conversion.toHexString(bytes))
        );
      }
      return new Values.AddressValue(dataType, CodecUtils.Conversion.toAddress(bytes));

    case "contract":
      if(!permissivePadding && !checkPaddingLeft(bytes, CodecUtils.EVM.ADDRESS_SIZE)) {
        if(strict) {
          throw new StopDecodingError();
        }
        return new Values.ContractErrorResult(
          dataType,
          new Values.ContractPaddingError(CodecUtils.Conversion.toHexString(bytes))
        );
      }
      const fullType = <Types.ContractType>Types.fullType(dataType, info.userDefinedTypes);
      const contractValueInfo = <Values.ContractValueInfo> (yield* decodeContract(bytes, info));
      return new Values.ContractValue(fullType, contractValueInfo);

    case "bytes":
      if(dataType.kind === "static") {
        //first, check padding (if needed)
        if(!permissivePadding && !checkPaddingRight(bytes, dataType.length)) {
          if(strict) {
            throw new StopDecodingError();
          }
          return new Values.BytesErrorResult(
            dataType,
            new Values.BytesPaddingError(CodecUtils.Conversion.toHexString(bytes))
          );
        }
        //now, truncate to appropriate length
        bytes = bytes.slice(0, dataType.length);
      }
      //we don't need to pass in length to the conversion, since that's for *adding* padding
      //(there is also no padding check for dynamic bytes)
      return new Values.BytesValue(dataType, CodecUtils.Conversion.toHexString(bytes));

    case "string":
      //there is no padding check for strings
      //HACK WARNING: we don't convert UTF-8 to UTF-16! we need to find some way to do that
      //that doesn't throw an error, since we *don't* want to return an error value for
      //invalid UTF-8 (since this can be generated via normal Solidity)
      return new Values.StringValue(dataType, String.fromCharCode.apply(undefined, bytes));

    case "function":
      switch(dataType.visibility) {
        case "external":
          if(!checkPaddingRight(bytes, CodecUtils.EVM.ADDRESS_SIZE + CodecUtils.EVM.SELECTOR_SIZE)) {
            if(strict) {
              throw new StopDecodingError();
            }
            return new Values.FunctionExternalErrorResult(
              dataType,
              new Values.FunctionExternalNonStackPaddingError(CodecUtils.Conversion.toHexString(bytes))
            );
          }
          const address = bytes.slice(0, CodecUtils.EVM.ADDRESS_SIZE);
          const selector = bytes.slice(CodecUtils.EVM.ADDRESS_SIZE, CodecUtils.EVM.ADDRESS_SIZE + CodecUtils.EVM.SELECTOR_SIZE);
          return new Values.FunctionExternalValue(dataType,
            <Values.FunctionExternalValueInfo> (yield* decodeExternalFunction(address, selector, info))
          );
        case "internal":
          if(!checkPaddingLeft(bytes, 2 * CodecUtils.EVM.PC_SIZE)) {
            if(strict) {
              throw new StopDecodingError();
            }
            return new Values.FunctionInternalErrorResult(
              dataType,
              new Values.FunctionInternalPaddingError(CodecUtils.Conversion.toHexString(bytes))
            );
          }
          const deployedPc = bytes.slice(-CodecUtils.EVM.PC_SIZE);
          const constructorPc = bytes.slice(-CodecUtils.EVM.PC_SIZE * 2, -CodecUtils.EVM.PC_SIZE);
          return decodeInternalFunction(dataType, deployedPc, constructorPc, info);
      }
      break; //to satisfy TypeScript

    case "enum": {
      const numeric = CodecUtils.Conversion.toBN(bytes);
      const fullType = <Types.EnumType>Types.fullType(dataType, info.userDefinedTypes);
      if(!fullType.options) {
        if(strict) {
          throw new StopDecodingError();
        }
        return new Values.EnumErrorResult(
          fullType,
          new Values.EnumNotFoundDecodingError(fullType, numeric)
        );
      }
      const numOptions = fullType.options.length;
      const numBytes = Math.ceil(Math.log2(numOptions) / 8);
      if(!checkPaddingLeft(bytes, numBytes)) {
        if(strict) {
          throw new StopDecodingError();
        }
        return new Values.EnumErrorResult(
          fullType,
          new Values.EnumPaddingError(fullType, CodecUtils.Conversion.toHexString(bytes))
        );
      }
      if(numeric.ltn(numOptions)) {
        const name = fullType.options[numeric.toNumber()];
        return new Values.EnumValue(fullType, numeric, name);
      }
      else {
        if(strict) {
          throw new StopDecodingError();
        }
        return new Values.EnumErrorResult(
          fullType,
          new Values.EnumOutOfRangeError(fullType, numeric)
        );
      }
    }

    case "fixed": {
      //skipping padding check as we don't support this anyway
      const hex = CodecUtils.Conversion.toHexString(bytes);
      if(strict) {
        throw new StopDecodingError();
      }
      return new Values.FixedErrorResult(
        dataType,
        new Values.FixedPointNotYetSupportedError(hex)
      );
    }
    case "ufixed": {
      //skipping padding check as we don't support this anyway
      const hex = CodecUtils.Conversion.toHexString(bytes);
      if(strict) {
        throw new StopDecodingError();
      }
      return new Values.UfixedErrorResult(
        dataType,
        new Values.FixedPointNotYetSupportedError(hex)
      );
    }
  }
}

//NOTE that this function returns a ContractValueInfo, not a ContractResult
export function* decodeContract(addressBytes: Uint8Array, info: EvmInfo): IterableIterator<Values.ContractValueInfo | DecoderRequest | Uint8Array> {
  let address = CodecUtils.Conversion.toAddress(addressBytes);
  let codeBytes: Uint8Array = yield {
    type: "code",
    address
  };
  let code = CodecUtils.Conversion.toHexString(codeBytes);
  let context = CodecUtils.Contexts.findDecoderContext(info.contexts, code);
  if(context !== null && context.contractName !== undefined) {
    return new Values.ContractValueInfoKnown(
      address,
      CodecUtils.Contexts.contextToType(context)
    );
  }
  else {
    return new Values.ContractValueInfoUnknown(address);
  }
}

//note: address can have extra zeroes on the left like elsewhere, but selector should be exactly 4 bytes
//NOTE this again returns a FunctionExternalValueInfo, not a FunctionExternalResult
export function* decodeExternalFunction(addressBytes: Uint8Array, selectorBytes: Uint8Array, info: EvmInfo): IterableIterator<Values.FunctionExternalValueInfo | DecoderRequest | GeneratorJunk> {
  let contract = <Values.ContractValueInfo> (yield* decodeContract(addressBytes, info));
  let selector = CodecUtils.Conversion.toHexString(selectorBytes);
  if(contract.kind === "unknown") {
    return new Values.FunctionExternalValueInfoUnknown(contract, selector)
  }
  let contractId = contract.class.id;
  let context = Object.values(info.contexts).find(
    context => context.contractId === contractId
  );
  let abiEntry = context.abi !== undefined
    ? context.abi[selector]
    : undefined;
  if(abiEntry === undefined) {
    return new Values.FunctionExternalValueInfoInvalid(contract, selector)
  }
  let functionName = abiEntry.name;
  return new Values.FunctionExternalValueInfoKnown(contract, selector, functionName)
}

//this one works a bit differently -- in order to handle errors, it *does* return a FunctionInternalResult
export function decodeInternalFunction(dataType: Types.FunctionType, deployedPcBytes: Uint8Array, constructorPcBytes: Uint8Array, info: EvmInfo): Values.FunctionInternalResult {
  let deployedPc: number = CodecUtils.Conversion.toBN(deployedPcBytes).toNumber();
  let constructorPc: number = CodecUtils.Conversion.toBN(constructorPcBytes).toNumber();
  let context: Types.ContractType = {
    typeClass: "contract",
    id: info.currentContext.contractId,
    typeName: info.currentContext.contractName,
    contractKind: info.currentContext.contractKind,
    payable: info.currentContext.payable
  };
  //before anything else: do we even have an internal functions table?
  //if not, we'll just return the info we have without really attemting to decode
  if(!info.internalFunctionsTable) {
    return new Values.FunctionInternalValue(
      dataType,
      new Values.FunctionInternalValueInfoUnknown(context, deployedPc, constructorPc)
    );
  }
  //also before we continue: is the PC zero? if so let's just return that
  if(deployedPc === 0 && constructorPc === 0) {
    return new Values.FunctionInternalValue(
      dataType,
      new Values.FunctionInternalValueInfoException(context, deployedPc, constructorPc)
    );
  }
  //another check: is only the deployed PC zero?
  if(deployedPc === 0 && constructorPc !== 0) {
    return new Values.FunctionInternalErrorResult(
      dataType,
      new Values.MalformedInternalFunctionError(context, constructorPc)
    );
  }
  //one last pre-check: is this a deployed-format pointer in a constructor?
  if(info.currentContext.isConstructor && constructorPc === 0) {
    return new Values.FunctionInternalErrorResult(
      dataType,
      new Values.DeployedFunctionInConstructorError(context, deployedPc)
    );
  }
  //otherwise, we get our function
  let pc = info.currentContext.isConstructor
    ? constructorPc
    : deployedPc;
  let functionEntry = info.internalFunctionsTable[pc];
  if(!functionEntry) {
    //if it's not zero and there's no entry... error!
    return new Values.FunctionInternalErrorResult(
      dataType,
      new Values.NoSuchInternalFunctionError(context, deployedPc, constructorPc)
    );
  }
  if(functionEntry.isDesignatedInvalid) {
    return new Values.FunctionInternalValue(
      dataType,
      new Values.FunctionInternalValueInfoException(context, deployedPc, constructorPc)
    );
  }
  let name = functionEntry.name;
  let definedIn: Types.ContractType = {
    typeClass: "contract",
    id: functionEntry.contractId,
    typeName: functionEntry.contractName,
    contractKind: functionEntry.contractKind,
    payable: functionEntry.contractPayable
  };
  return new Values.FunctionInternalValue(
    dataType,
    new Values.FunctionInternalValueInfoKnown(context, deployedPc, constructorPc, name, definedIn)
  );
}

function checkPaddingRight(bytes: Uint8Array, length: number): boolean {
  let padding = bytes.slice(length); //cut off the first length bytes
  return padding.every(paddingByte => paddingByte === 0);
}

//exporting this one for use in stack.ts
export function checkPaddingLeft(bytes: Uint8Array, length: number): boolean {
  let padding = bytes.slice(0, -length); //cut off the last length bytes
  return padding.every(paddingByte => paddingByte === 0);
}

function checkPaddingSigned(bytes: Uint8Array, length: number): boolean {
  let padding = bytes.slice(0, -length); //padding is all but the last length bytes
  let value = bytes.slice(-length); //meanwhile the actual value is those last length bytes
  let signByte = value[0] & 0x80 ? 0xff : 0x00;
  return padding.every(paddingByte => paddingByte === signByte);
}