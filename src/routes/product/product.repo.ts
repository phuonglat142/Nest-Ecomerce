import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/services/prisma.service';
import {
  CreateProductBodyType,
  GetProductDetailResTYpe,
  GetProductsResType,
  UpdateProductBodyType,
} from './product.model';
import { ALL_LANGUAGES_CODE, OrderByType, SortBy, SortByType } from 'src/shared/constants/other.constant';
import { ProductType } from 'src/shared/models/shared-product.model';
import { SerializeAll } from 'src/shared/decorators/serialize.decorator';
import { Prisma } from 'src/generated/prisma/client';

@Injectable()
@SerializeAll()
export class ProductRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async list({
    limit,
    page,
    name,
    brandIds,
    categories,
    minPrice,
    maxPrice,
    createdById,
    isPublic,
    languageId,
    orderBy,
    sortBy,
  }: {
    limit: number;
    page: number;
    name?: string;
    brandIds?: number[];
    categories?: number[];
    minPrice?: number;
    maxPrice?: number;
    createdById?: number;
    isPublic?: boolean;
    languageId: string;
    orderBy: OrderByType;
    sortBy: SortByType;
  }): Promise<GetProductsResType> {
    const skip = (page - 1) * limit;
    const take = limit;

    let where: Prisma.ProductWhereInput = {
      deletedAt: null,
      createdById: createdById ? createdById : undefined,
    };

    if (isPublic === true) {
      where.publishedAt = {
        lte: new Date(),
        not: null,
      };
    } else if (isPublic === false) {
      where = {
        ...where,
        OR: [{ publishedAt: null }, { publishedAt: { gt: new Date() } }],
      };
    }

    if (name) {
      where.name = {
        contains: name,
        mode: 'insensitive',
      };
    }

    if (brandIds && brandIds.length > 0) {
      where.brandId = {
        in: brandIds,
      };
    }

    if (categories && categories.length > 0) {
      where.categories = {
        some: {
          id: {
            in: categories,
          },
        },
      };
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      where.basePrice = {
        gte: minPrice,
        lte: maxPrice,
      };
    }

    // Mặc định sort theo createdAt mới nhất
    let caculatedOrderBy: Prisma.ProductOrderByWithRelationInput | Prisma.ProductOrderByWithRelationInput[] = {
      createdAt: orderBy,
    };

    if (sortBy === SortBy.Price) {
      caculatedOrderBy = {
        basePrice: orderBy,
      };
    } else if (sortBy === SortBy.Sale) {
      caculatedOrderBy = {
        orders: {
          _count: orderBy,
        },
      };
    }

    const [totalItems, data] = await Promise.all([
      this.prismaService.product.count({
        where,
      }),
      this.prismaService.product.findMany({
        where,
        include: {
          productTranslations: {
            where: languageId === ALL_LANGUAGES_CODE ? { deletedAt: null } : { languageId, deletedAt: null },
          },
          orders: {
            where: {
              deletedAt: null,
              status: 'DELIVERED',
            },
          },
        },

        orderBy: caculatedOrderBy,
        skip,
        take,
      }),
    ]);

    return {
      totalItems,
      page: page,
      limit: limit,
      totalPages: Math.ceil(totalItems / limit),
      data,
    } as any;
  }

  findById(productId: number): Promise<ProductType | null> {
    return this.prismaService.product.findUnique({
      where: {
        id: productId,
        deletedAt: null,
      },
    }) as any;
  }

  getDetail({
    productId,
    languageId,
    isPublic,
  }: {
    productId: number;
    languageId: string;
    isPublic?: boolean;
  }): Promise<GetProductDetailResTYpe | null> {
    let where: Prisma.ProductWhereUniqueInput = {
      id: productId,
      deletedAt: null,
    };

    if (isPublic === true) {
      where.publishedAt = {
        lte: new Date(),
        not: null,
      };
    } else if (isPublic === false) {
      where = {
        ...where,
        OR: [{ publishedAt: null }, { publishedAt: { gt: new Date() } }],
      };
    }

    return this.prismaService.product.findUnique({
      where,
      include: {
        productTranslations: {
          where: languageId === ALL_LANGUAGES_CODE ? { deletedAt: null } : { languageId, deletedAt: null },
        },
        skus: {
          where: {
            deletedAt: null,
          },
        },
        brand: {
          include: {
            brandTranslations: {
              where: languageId === ALL_LANGUAGES_CODE ? { deletedAt: null } : { languageId, deletedAt: null },
            },
          },
        },
        categories: {
          where: {
            deletedAt: null,
          },
          include: {
            categoryTranslations: {
              where: languageId === ALL_LANGUAGES_CODE ? { deletedAt: null } : { languageId, deletedAt: null },
            },
          },
        },
      },
    }) as any;
  }

  create({
    createdById,
    data,
  }: {
    createdById: number;
    data: CreateProductBodyType;
  }): Promise<GetProductDetailResTYpe> {
    const { skus, categories, ...productData } = data;
    return this.prismaService.product.create({
      data: {
        createdById,
        ...productData,
        categories: {
          connect: categories.map((category) => ({ id: category })),
        },
        skus: {
          createMany: {
            data: skus.map((sku) => ({
              ...sku,
              createdById,
            })),
          },
        },
      },
      include: {
        productTranslations: {
          where: {
            deletedAt: null,
          },
        },
        skus: {
          where: {
            deletedAt: null,
          },
        },
        brand: {
          include: {
            brandTranslations: {
              where: {
                deletedAt: null,
              },
            },
          },
        },
        categories: {
          where: {
            deletedAt: null,
          },
          include: {
            categoryTranslations: {
              where: {
                deletedAt: null,
              },
            },
          },
        },
      },
    }) as any;
  }

  async update({
    id,
    updatedById,
    data,
  }: {
    id: number;
    updatedById: number;
    data: UpdateProductBodyType;
  }): Promise<ProductType> {
    const { skus: dataSkus, categories, ...productData } = data;

    //SKU đã tồn tại trong DB nhưng  không có trong data payload thì sẽ bị xóa
    //SKU đã tồn tại trong DB nhưng có trong data payload thì sẽ cập nhật
    //SKU không tồn tại trong DB nhưng có trong data payload thì sẽ được tạo mới

    // 1. Lấy danh sách SKU hiện tại trong DB
    const existingSkus = await this.prismaService.sKU.findMany({
      where: {
        productId: id,
        deletedAt: null,
      },
    });

    // 2. Tìm các Skus cần xóa (tồn tại trong DB nhưng không có trong data payload)
    const skusToDelete = existingSkus.filter((sku) => dataSkus.every((dataSku) => dataSku.value !== sku.value));
    const skuIdsToDelete = skusToDelete.map((sku) => sku.id);

    // 3. Mapping ID vào trong data payload
    const skusWithId = dataSkus.map((dataSku) => {
      const existingSku = existingSkus.find((existingSku) => existingSku.value === dataSku.value);
      return {
        ...dataSku,
        id: existingSku ? existingSku.id : null,
      };
    });

    // 4. Tìm các skus để cập nhật
    const skusToUpdate = skusWithId.filter((sku) => sku.id !== null);

    // 5. Tìm các skus để tạo mới
    const skusToCreate = skusWithId
      .filter((sku) => sku.id === null)
      .map((sku) => {
        const { id: skuId, ...data } = sku;
        return {
          ...data,
          productId: id,
          createdById: updatedById,
        };
      });

    const [product] = (await this.prismaService.$transaction([
      //Cập nhật product
      this.prismaService.product.update({
        where: {
          id,
          deletedAt: null,
        },
        data: {
          ...productData,
          updatedById,
          categories: {
            connect: categories.map((category) => ({ id: category })),
          },
        },
      }),
      // Xoá mềm các sku không có trong data payload
      this.prismaService.sKU.updateMany({
        where: {
          id: {
            in: skuIdsToDelete,
          },
        },
        data: {
          deletedAt: new Date(),
          deletedById: updatedById,
        },
      }),

      // Cập nhật các sku có trong data payload
      ...skusToUpdate.map((sku) =>
        this.prismaService.sKU.update({
          where: {
            id: sku.id as number,
          },
          data: {
            value: sku.value,
            price: sku.price,
            stock: sku.stock,
            image: sku.image,
            updatedById,
          },
        }),
      ),

      //Thêm mới các sku không có trong DB
      this.prismaService.sKU.createMany({
        data: skusToCreate,
      }),
    ])) as any;

    return product;
  }

  async delete({ id, deletedById }: { id: number; deletedById: number }, isHard?: boolean): Promise<ProductType> {
    if (isHard) {
      return this.prismaService.product.delete({
        where: {
          id,
        },
      }) as any;
    }

    const [product] = (await Promise.all([
      this.prismaService.product.update({
        where: {
          id,
          deletedAt: null,
        },
        data: {
          deletedAt: new Date(),
          deletedById,
        },
      }),
      this.prismaService.productTranslation.updateMany({
        where: {
          productId: id,
          deletedAt: null,
        },
        data: {
          deletedAt: new Date(),
          deletedById,
        },
      }),
      this.prismaService.sKU.updateMany({
        where: {
          productId: id,
          deletedAt: null,
        },
        data: {
          deletedAt: new Date(),
          deletedById,
        },
      }),
    ])) as any;

    return product;
  }
}
