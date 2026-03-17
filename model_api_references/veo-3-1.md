# Generate Veo3.1 Video

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /api/v1/veo/generate:
    post:
      summary: Generate Veo3.1 Video
      deprecated: false
      description: >-
        ::: info[]

        Create a new video generation task using the Veo3.1 AI model.

        :::

        Our **Veo 3.1 Generation API** is more than a direct wrapper around
        Google's baseline. It layers extensive optimisation and reliability
        tooling on top of the official models, giving you greater flexibility
        and markedly higher success rates — **25% of the official Google
        pricing** (see [kie.ai/pricing](https://kie.ai/pricing) for full
        details).


        | Capability           | Details |

        | :------------------- | :------ |

        | **Models**           | • **Veo 3.1 Quality** — flagship model, highest
        fidelity<br />• **Veo 3.1 Fast** — cost-efficient variant that still
        delivers strong visual results |

        | **Tasks**            | • **Text → Video**<br />• **Image → Video**
        (single reference frame or first and last frames)<br />• **Material →
        Video** (based on material images) |

        | **Generation Modes** | • **TEXT\_2\_VIDEO** — Text-to-video: using
        text prompts only<br />• **FIRST\_AND\_LAST\_FRAMES\_2\_VIDEO** — First
        and last frames to video: generate transition videos using one or two
        images<br />• **REFERENCE\_2\_VIDEO** — Material-to-video: based on
        material images (**Fast model only**, supports **16:9 & 9:16**) |

        | **Aspect Ratios**    | Supports both native **16:9** and **9:16**
        outputs. **Auto** mode lets the system decide aspect ratio based on
        input materials and internal strategy (for production control, we
        recommend explicitly setting `aspect_ratio`). |

        | **Output Quality**   | Both **16:9** and **9:16** support **1080P**
        and **4K** outputs. **4K requires extra credits** (approximately **2×
        the credits of generating a Fast mode video**) and is requested via a
        separate 4K endpoint. |

        | **Audio Track**      | All videos ship with background audio by
        default. In rare cases, upstream may suppress audio when the scene is
        deemed sensitive (e.g. minors). |


        ### Why our Veo 3.1 API is different


        1. **True vertical video** – Native Veo 3.1 supports **9:16** output,
        delivering authentic vertical videos without the need for re-framing or
        manual editing.

        2. **Global language reach** – Our flow supports multilingual prompts by
        default (no extra configuration required).

        3. **Significant cost savings** – Our rates are 25% of Google's direct
        API pricing.
      operationId: generate-veo3-1-video
      tags:
        - docs/en/Market/Veo3.1 API
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                prompt:
                  type: string
                  description: >-
                    Text prompt describing the desired video content. Required
                    for all generation modes.


                    - Should be detailed and specific in describing video
                    content

                    - Can include actions, scenes, style and other information

                    - For image-to-video, describe how you want the image to
                    come alive
                  examples:
                    - A dog playing in a park
                imageUrls:
                  type: array
                  items:
                    type: string
                  description: >-
                    Image URL list (used in image-to-video mode). Supports 1 or
                    2 images:


                    - **1 image**: The generated video will unfold around this
                    image, with the image content presented dynamically

                    - **2 images**: The first image serves as the video's first
                    frame, and the second image serves as the video's last
                    frame, with the video transitioning between them

                    - Must be valid image URLs

                    - Images must be accessible to the API server.
                  examples:
                    - - http://example.com/image1.jpg
                      - http://example.com/image2.jpg
                model:
                  type: string
                  description: >-
                    Select the model type to use.


                    - veo3: Veo 3.1 Quality, supports both text-to-video and
                    image-to-video generation

                    - veo3_fast: Veo3.1 Fast generation model, supports both
                    text-to-video and image-to-video generation
                  enum:
                    - veo3
                    - veo3_fast
                  default: veo3_fast
                  examples:
                    - veo3_fast
                generationType:
                  type: string
                  description: >-
                    Video generation mode (optional). Specifies different video
                    generation approaches:


                    - **TEXT_2_VIDEO**: Text-to-video - Generate videos using
                    only text prompts

                    - **FIRST_AND_LAST_FRAMES_2_VIDEO**: First and last frames
                    to video - Flexible image-to-video generation mode
                      - 1 image: Generate video based on the provided image
                      - 2 images: First image as first frame, second image as last frame, generating transition video
                    - **REFERENCE_2_VIDEO**: Reference-to-video - Generate
                    videos based on reference images, requires 1-3 images in
                    imageUrls (minimum 1, maximum 3)


                    **Important Notes**:

                    - REFERENCE_2_VIDEO mode currently only supports veo3_fast
                    model

                    - If not specified, the system will automatically determine
                    the generation mode based on whether imageUrls are provided
                  enum:
                    - TEXT_2_VIDEO
                    - FIRST_AND_LAST_FRAMES_2_VIDEO
                    - REFERENCE_2_VIDEO
                  examples:
                    - TEXT_2_VIDEO
                aspect_ratio:
                  type: string
                  description: >-
                    Video aspect ratio. Specifies the dimension ratio of the
                    generated video. Available options:


                    - 16:9: Landscape video format. 

                    - 9:16: Portrait video format, suitable for mobile short
                    videos

                    - Auto: In auto mode, the video will be automatically
                    center-cropped based on whether your uploaded image is
                    closer to 16:9 or 9:16.


                    Default value is 16:9.
                  enum:
                    - '16:9'
                    - '9:16'
                    - Auto
                  default: '16:9'
                  examples:
                    - '16:9'
                seeds:
                  type: integer
                  description: >-
                    (Optional) Random seed parameter to control the randomness
                    of the generated content. Value range: 10000-99999. The same
                    seed will generate similar video content, different seeds
                    will generate different content. If not provided, the system
                    will assign one automatically.
                  minimum: 10000
                  maximum: 99999
                  examples:
                    - 12345
                callBackUrl:
                  type: string
                  description: >-
                    Completion callback URL for receiving video generation
                    status updates.


                    - Optional but recommended for production use

                    - System will POST task completion status to this URL when
                    the video generation is completed

                    - Callback will include task results, video URLs, and status
                    information

                    - Your callback endpoint should accept POST requests with
                    JSON payload

                    - For detailed callback format and implementation guide, see
                    [Callback
                    Documentation](https://docs.kie.ai/veo3-api/generate-veo-3-video-callbacks)

                    - Alternatively, use the Get Video Details endpoint to poll
                    task status

                    - To ensure callback security, see [Webhook Verification
                    Guide](/common-api/webhook-verification) for signature
                    verification implementation
                  examples:
                    - http://your-callback-url.com/complete
                enableFallback:
                  type: boolean
                  description: >-
                    Deprecated Enable fallback functionality. When set to true,
                    if the official Veo3.1 video generation service is
                    unavailable or encounters exceptions, the system will
                    automatically switch to a backup model for video generation
                    to ensure task continuity and reliability. Default value is
                    false.


                    - When fallback is enabled, backup model will be used for
                    the following errors:
                      - public error minor upload
                      - Your prompt was flagged by Website as violating content policies
                      - public error prominent people upload
                    - Fallback mode requires 16:9 aspect ratio and uses 1080p
                    resolution by default

                    - **Note**: Videos generated through fallback mode cannot be
                    accessed via the Get 1080P Video endpoint

                    - **Credit Consumption**: Successful fallback has different
                    credit consumption, please see https://kie.ai/pricing for
                    pricing details


                    **Note: This parameter is deprecated. Please remove this
                    parameter from your requests. The system has automatically
                    optimized the content review mechanism without requiring
                    manual fallback configuration.**
                  default: false
                  deprecated: true
                  examples:
                    - false
                enableTranslation:
                  type: boolean
                  description: >-
                    Enable prompt translation to English. When set to true, the
                    system will automatically translate prompts to English
                    before video generation for better generation results.
                    Default value is true.


                    - true: Enable translation, prompts will be automatically
                    translated to English

                    - false: Disable translation, use original prompts directly
                    for generation
                  default: true
                  examples:
                    - true
                watermark:
                  type: string
                  description: >-
                    Watermark text.


                    - Optional parameter

                    - If provided, a watermark will be added to the generated
                    video
                  examples:
                    - MyBrand
              required:
                - prompt
              x-apidog-orders:
                - prompt
                - imageUrls
                - model
                - generationType
                - aspect_ratio
                - seeds
                - callBackUrl
                - enableFallback
                - enableTranslation
                - watermark
              examples:
                - prompt: A dog playing in a park
                  imageUrls:
                    - http://example.com/image1.jpg
                    - http://example.com/image2.jpg
                  model: veo3_fast
                  watermark: MyBrand
                  callBackUrl: http://your-callback-url.com/complete
                  aspect_ratio: '16:9'
                  seeds: 12345
                  enableFallback: false
                  enableTranslation: true
                  generationType: REFERENCE_2_VIDEO
              x-apidog-ignore-properties: []
            example:
              prompt: A dog playing in a park
              imageUrls:
                - http://example.com/image1.jpg
                - http://example.com/image2.jpg
              model: veo3_fast
              watermark: MyBrand
              callBackUrl: http://your-callback-url.com/complete
              aspect_ratio: '16:9'
              seeds: 12345
              enableFallback: false
              enableTranslation: true
              generationType: REFERENCE_2_VIDEO
      responses:
        '200':
          description: Request successful
          content:
            application/json:
              schema:
                type: object
                properties:
                  code:
                    type: integer
                    enum:
                      - 200
                      - 400
                      - 401
                      - 402
                      - 404
                      - 422
                      - 429
                      - 455
                      - 500
                      - 501
                      - 505
                    description: >-
                      Response status code


                      - **200**: Success - Request has been processed
                      successfully

                      - **400**: 1080P is processing. It should be ready in 1-2
                      minutes. Please check back shortly.

                      - **401**: Unauthorized - Authentication credentials are
                      missing or invalid

                      - **402**: Insufficient Credits - Account does not have
                      enough credits to perform the operation

                      - **404**: Not Found - The requested resource or endpoint
                      does not exist

                      - **422**: Validation Error - Request parameters failed
                      validation. When fallback is not enabled and generation
                      fails, error message format: Your request was rejected by
                      Flow(original error message). You may consider using our
                      other fallback channels, which are likely to succeed.
                      Please refer to the documentation.

                      - **429**: Rate Limited - Request limit has been exceeded
                      for this resource

                      - **455**: Service Unavailable - System is currently
                      undergoing maintenance

                      - **500**: Server Error - An unexpected error occurred
                      while processing the request

                      - **501**: Generation Failed - Video generation task
                      failed

                      - **505**: Feature Disabled - The requested feature is
                      currently disabled
                  msg:
                    type: string
                    description: Error message when code != 200
                    examples:
                      - success
                  data:
                    type: object
                    properties:
                      taskId:
                        type: string
                        description: >-
                          Task ID, can be used with Get Video Details endpoint
                          to query task status
                        examples:
                          - veo_task_abcdef123456
                    x-apidog-orders:
                      - taskId
                    x-apidog-ignore-properties: []
                x-apidog-orders:
                  - code
                  - msg
                  - data
                x-apidog-ignore-properties: []
              example:
                code: 200
                msg: success
                data:
                  taskId: veo_task_abcdef123456
          headers: {}
          x-apidog-name: success
        '500':
          description: request failed
          content:
            application/json:
              schema:
                type: object
                properties:
                  code:
                    type: integer
                    description: >-
                      Response status code


                      - **200**: Success - Request has been processed
                      successfully

                      - **401**: Unauthorized - Authentication credentials are
                      missing or invalid

                      - **402**: Insufficient Credits - Account does not have
                      enough credits to perform the operation

                      - **404**: Not Found - The requested resource or endpoint
                      does not exist

                      - **422**: Validation Error - The request parameters
                      failed validation checks

                      - **429**: Rate Limited - Request limit has been exceeded
                      for this resource

                      - **455**: Service Unavailable - System is currently
                      undergoing maintenance

                      - **500**: Server Error - An unexpected error occurred
                      while processing the request

                      - **501**: Generation Failed - Content generation task
                      failed

                      - **505**: Feature Disabled - The requested feature is
                      currently disabled
                  msg:
                    type: string
                    description: Response message, error description when failed
                  data:
                    type: object
                    properties: {}
                    x-apidog-orders: []
                    x-apidog-ignore-properties: []
                x-apidog-orders:
                  - code
                  - msg
                  - data
                required:
                  - code
                  - msg
                  - data
                x-apidog-ignore-properties: []
              example:
                code: 500
                msg: >-
                  Server Error - An unexpected error occurred while processing
                  the request
                data: null
          headers: {}
          x-apidog-name: 'Error '
      security:
        - BearerAuth: []
          x-apidog:
            schemeGroups:
              - id: kn8M4YUlc5i0A0179ezwx
                schemeIds:
                  - BearerAuth
            required: true
            use:
              id: kn8M4YUlc5i0A0179ezwx
            scopes:
              kn8M4YUlc5i0A0179ezwx:
                BearerAuth: []
      callbacks:
        onVideoGenerated:
          '{$request.body#/callBackUrl}':
            post:
              summary: Video Generation Callback
              description: >-
                When the video generation task is completed, the system will
                send the result to your provided callback URL via POST request
              requestBody:
                required: true
                content:
                  application/json:
                    schema:
                      type: object
                      properties:
                        code:
                          type: integer
                          description: >-
                            Status code


                            - **200**: Success - Video generation task
                            successfully

                            - **400**: Your prompt was flagged by Website as
                            violating content policies.

                            Only English prompts are supported at this time.

                            Failed to fetch the image. Kindly verify any access
                            limits set by you or your service provider.

                            public error unsafe image upload.

                            - **422**: Fallback failed - When fallback is not
                            enabled and specific errors occur, returns error
                            message format: Your request was rejected by
                            Flow(original error message). You may consider using
                            our other fallback channels, which are likely to
                            succeed. Please refer to the documentation.

                            - **500**: Internal Error, Please try again later.

                            Internal Error - Timeout

                            - **501**: Failed - Video generation task failed
                          enum:
                            - 200
                            - 400
                            - 422
                            - 500
                            - 501
                        msg:
                          type: string
                          description: Status message
                          example: Veo3.1 video generated successfully.
                        data:
                          type: object
                          properties:
                            taskId:
                              type: string
                              description: Task ID
                              example: veo_task_abcdef123456
                            info:
                              type: object
                              properties:
                                resultUrls:
                                  type: string
                                  description: Generated video URLs
                                  example: '[http://example.com/video1.mp4]'
                                originUrls:
                                  type: string
                                  description: >-
                                    Original video URLs. Only has value when
                                    aspect_ratio is not 16:9
                                  example: '[http://example.com/original_video1.mp4]'
                                resolution:
                                  type: string
                                  description: Video resolution information
                                  example: 1080p
                            fallbackFlag:
                              type: boolean
                              description: >-
                                Whether generated using fallback model. True
                                means backup model was used, false means primary
                                model was used
                              example: false
                              deprecated: true
              responses:
                '200':
                  description: Callback received successfully
      x-apidog-folder: docs/en/Market/Veo3.1 API
      x-apidog-status: released
      x-run-in-apidog: https://app.apidog.com/web/project/1184766/apis/api-28506311-run
components:
  schemas: {}
  securitySchemes:
    BearerAuth:
      type: bearer
      scheme: bearer
      bearerFormat: API Key
      description: |-
        所有 API 均需要通过 Bearer Token 进行身份验证。

        获取 API Key：
        1. 访问 [API Key 管理页面](https://kie.ai/api-key) 获取您的 API Key

        使用方法：
        在请求头中添加：
        Authorization: Bearer YOUR_API_KEY

        注意：
        - 请妥善保管您的 API Key，不要与他人分享
        - 如果您怀疑 API Key 已泄露，请立即在管理页面重置
servers:
  - url: https://api.kie.ai
    description: 正式环境
security:
  - BearerAuth: []
    x-apidog:
      schemeGroups:
        - id: kn8M4YUlc5i0A0179ezwx
          schemeIds:
            - BearerAuth
      required: true
      use:
        id: kn8M4YUlc5i0A0179ezwx
      scopes:
        kn8M4YUlc5i0A0179ezwx:
          BearerAuth: []

```

Pricing: Fast mode (text-to-video / image-to-video / reference-to-video): 60 credits per video (≈ $0.30) ·
Quality mode (text-to-video / image-to-video): 250 credits per video (≈ $1.25)