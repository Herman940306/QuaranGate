import "server-only";

export type ProductDataErrorCode =
  | "PRODUCT_DATA_NOT_FOUND"
  | "PRODUCT_DATA_FORBIDDEN"
  | "PRODUCT_DATA_STALE_VERSION"
  | "PRODUCT_DATA_UNAVAILABLE"
  | "PRODUCT_DATA_INVALID";

export class ProductDataError extends Error {
  constructor(
    readonly code: ProductDataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProductDataError";
  }
}
