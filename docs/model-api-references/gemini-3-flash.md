# Gemini 3 Flash

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /gemini-3-flash/v1/chat/completions:
    post:
      summary: Gemini 3 Flash
      deprecated: false
      description: >-
        ### Streaming Support


        When `stream: true` is set in the request, the API returns responses as
        server-sent events (SSE) with `Content-Type: text/event-stream`. This
        allows for progressive response delivery, where message deltas are sent
        incrementally as they are generated. Each event contains partial message
        content, enabling real-time display of responses in your application.


        **Streaming Response Format:**

        - Content-Type: `text/event-stream`

        - Each event line starts with `data: ` followed by JSON

        - Events contain incremental message deltas

        - Final event indicates completion with `finish_reason`


        <CardGroup cols={2}>
          <Card title="Multimodal" icon="lucide-image">
            Supports text and image inputs
          </Card>
          <Card title="Real-time Search" icon="lucide-search">
            Google Search grounding enabled
          </Card>
          <Card title="Streaming" icon="lucide-list-minus">
            Server-sent events support
          </Card>
          <Card title="Flexible Roles" icon="lucide-users">
            Multiple message roles supported
          </Card>
        </CardGroup>



        <div style="padding: 20px; background-color: rgba(255, 152, 0, 0.05);
        border: 1px solid rgba(255, 152, 0, 0.15); border-left: 6px solid
        #ff9800; border-radius: 10px; margin: 25px 0;">
          <div style="display: flex; align-items: center; margin-bottom: 12px;">
            <span style="font-size: 22px; margin-right: 10px;">⚠️</span>
            <strong style="color: #e65100; font-size: 17px;">Important: Unified Media Structure</strong>
          </div>

          <p style="color: #444; margin-bottom: 15px; line-height: 1.6; font-size: 14px;">
            To simplify integration, <b>all media types</b> (Images, Videos, Audio, or Documents) in the <code>messages</code> array share the <b>exact same JSON structure</b>:
          </p>

          <ul style="color: #555; line-height: 1.8; margin-bottom: 15px; font-size: 14px;">
            <li>The <code>type</code> field is <b>fixed</b> as <code>"image_url"</code></li>
            <li>The <code>image_url</code> key name <b>remains unchanged</b> for all file types</li>
            <li>Only the <code>url</code> value points to your specific media file</li>
          </ul>

          <div style="background-color: #fdfdfd; padding: 12px; border-radius: 6px; border: 1px solid #eee; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 13px; color: #d32f2f;">
            <span style="color: #888; font-style: italic;">// Example for Video/Audio/PDF/Image:</span><br>
            { "type": "image_url", "image_url": { "url": "https://..." } }
          </div>
        </div>


        ## Tools Parameter


        The `tools` parameter is an optional array that allows you to define
        functions the model can call. The array can contain multiple objects.
        When using function calling, you can define multiple functions in the
        array.


        <AccordionGroup>

        <Accordion title="Function Calling">

        Define your own functions with parameters. You can define multiple
        functions in the `tools` array:


        ```json

        [
          {
            "type": "function",
            "function": {
              "name": "get_current_weather",
              "description": "Get the current weather in a given location",
              "parameters": {
                "type": "object",
                "properties": {
                  "location": {
                    "type": "string",
                    "description": "The city and state, e.g. San Francisco, CA"
                  },
                  "unit": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"]
                  }
                },
                "required": ["location"]
              }
            }
          },
          {
            "type": "function",
            "function": {
              "name": "get_stock_price",
              "description": "Get the current stock price for a given symbol",
              "parameters": {
                "type": "object",
                "properties": {
                  "symbol": {
                    "type": "string",
                    "description": "The stock symbol, e.g. AAPL"
                  }
                },
                "required": ["symbol"]
              }
            }
          }
        ]

        ```


        ### Function Declaration Requirements


        When implementing function calling in your prompt, you need to create a
        `tools` array containing one or more function declarations. You can
        define functions using JSON (specifically, a selected subset of OpenAPI
        schema format).


        A single function declaration can include the following parameters:


        - **`name`** (string, required): The unique name of the function (e.g.,
        `get_weather_forecast`, `send_email`). Use descriptive names without
        spaces or special characters (use underscores or camelCase).


        - **`description`** (string, optional but recommended): A clear and
        detailed description of what the function does and its purpose. This is
        crucial for the model to understand when to use the function. Be
        specific and provide examples when necessary (e.g., "Find movie theaters
        by location, with an option to also find movies currently showing at
        those theaters.").


        - **`parameters`** (object, required): Defines the input parameters
        expected by the function. Contains:
          - **`type`** (string): Specifies the overall data type, must be `"object"`.
          - **`properties`** (object): Lists individual parameters, each with:
            - **`type`** (string): The parameter's data type, such as `string`, `integer`, `boolean`, `array`.
            - **`description`** (string): Description of the parameter's purpose and format. Provide examples and constraints (e.g., "City and state, e.g. 'San Francisco, CA' or a postal code like '95616'.").
            - **`enum`** (array, optional): If parameter values come from a fixed set, use `enum` to list allowed values rather than just describing them in the description. This helps improve accuracy (e.g., `"enum": ["daylight", "cool", "warm"]`).
          - **`required`** (array): An array of strings listing the parameter names required for the function to run.
        </Accordion>

        </AccordionGroup>
      operationId: gemini-3-flash-chat-completions
      tags:
        - docs/en/Market/Chat  Models/Gemini
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                messages:
                  type: array
                  description: >-
                    An array of message objects. Each message has a role and
                    content.


                    **Unified Media File Format:**


                    In the content array, whether it's images, videos, audio, or
                    other document types, all media files use the same format
                    structure:


                    - The `type` field is always `"image_url"`

                    - The `image_url` field name remains unchanged

                    - The only thing that changes is the `url` value, which
                    points to the corresponding media file address


                    For example: images, videos, audio, PDFs, and other
                    documents all use the same `{ type: 'image_url', image_url:
                    { url: '...' } }` structure.
                  items:
                    $ref: '#/components/schemas/Message'
                  minItems: 1
                stream:
                  type: boolean
                  default: true
                  description: >-
                    If set to true, partial message deltas will be sent as
                    server-sent events. Default is true.
                tools:
                  type: array
                  description: >-
                    An optional array of tools the model may call. The array can
                    contain multiple objects. 
                     **Function calling**: Define your own functions with name, description, and parameters. You can define multiple functions in the array. Functions are defined using JSON (specifically, a selected subset of OpenAPI schema format).
                  items:
                    type: object
                    x-apidog-refs: {}
                    x-apidog-orders: []
                    properties: {}
                    x-apidog-ignore-properties: []
                  minItems: 0
                include_thoughts:
                  type: boolean
                  description: >-
                    Whether to include thoughts in the response. If set to true,
                    thoughts will be included in the response, otherwise they
                    will not be included. Default is true.
                  default: true
                reasoning_effort:
                  type: string
                  description: >-
                    The effort level for the model to use for reasoning. Low
                    effort is faster to respond, high effort is slower to
                    respond but solves more complex problems. Default is "high".
                  enum:
                    - low
                    - high
                  x-apidog-enum:
                    - value: low
                      name: ''
                      description: ''
                    - value: high
                      name: ''
                      description: ''
              required:
                - messages
              x-apidog-orders:
                - messages
                - stream
                - tools
                - include_thoughts
                - reasoning_effort
              examples:
                - messages:
                    - role: user
                      content:
                        - type: text
                          text: What is in this image?
                        - type: image_url
                          image_url:
                            url: >-
                              https://file.aiquickdraw.com/custom-page/akr/section-images/1759055072437dqlsclj2.png
                  tools:
                    - type: function
                      function:
                        name: googleSearch
                  stream: true
                  include_thoughts: true
                  response_format:
                    type: json_schema
                    properties:
                      response:
                        type: string
              x-apidog-ignore-properties: []
            example:
              messages:
                - role: user
                  content:
                    - type: text
                      text: What is in this image?
                    - type: image_url
                      image_url:
                        url: >-
                          https://file.aiquickdraw.com/custom-page/akr/section-images/1759055072437dqlsclj2.png
              tools:
                - type: function
                  function:
                    name: googleSearch
              stream: true
              include_thoughts: true
              reasoning_effort: high
      responses:
        '200':
          description: 'Request successful. '
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
                    description: Unique identifier for the chat completion
                    examples:
                      - chatcmpl-example-123
                  object:
                    type: string
                    description: Object type
                    examples:
                      - chat.completion
                  created:
                    type: integer
                    format: int64
                    description: Unix timestamp of when the completion was created
                    examples:
                      - 1677652288
                  model:
                    type: string
                    description: Model name
                    examples:
                      - gemini-2.5-flash
                  choices:
                    type: array
                    description: Array of completion choices
                    items:
                      type: object
                      properties:
                        index:
                          type: integer
                          description: Index of the choice
                          examples:
                            - 0
                        message:
                          type: object
                          properties:
                            role:
                              type: string
                              examples:
                                - assistant
                            content:
                              type: string
                              description: Message content
                          required:
                            - role
                            - content
                          x-apidog-orders:
                            - role
                            - content
                          x-apidog-ignore-properties: []
                        finish_reason:
                          type: string
                          description: Reason why the completion finished
                          examples:
                            - stop
                      required:
                        - index
                        - message
                        - finish_reason
                      x-apidog-orders:
                        - index
                        - message
                        - finish_reason
                      x-apidog-ignore-properties: []
                  usage:
                    type: object
                    properties:
                      prompt_tokens:
                        type: integer
                        description: Number of tokens in the prompt
                        examples:
                          - 10
                      completion_tokens:
                        type: integer
                        description: Number of tokens in the completion
                        examples:
                          - 50
                      total_tokens:
                        type: integer
                        description: Total number of tokens
                        examples:
                          - 60
                    required:
                      - prompt_tokens
                      - completion_tokens
                      - total_tokens
                    x-apidog-orders:
                      - prompt_tokens
                      - completion_tokens
                      - total_tokens
                    x-apidog-ignore-properties: []
                x-apidog-orders:
                  - id
                  - object
                  - created
                  - model
                  - choices
                  - usage
                x-apidog-ignore-properties: []
          headers: {}
          x-apidog-name: ''
        '400':
          description: Bad Request - Invalid request parameters
          content:
            application/json:
              schema:
                type: object
                properties:
                  error:
                    type: object
                    properties:
                      message:
                        type: string
                        examples:
                          - Invalid request parameters
                      type:
                        type: string
                        examples:
                          - invalid_request_error
                    x-apidog-orders:
                      - message
                      - type
                    x-apidog-ignore-properties: []
                x-apidog-orders:
                  - error
                x-apidog-ignore-properties: []
          headers: {}
          x-apidog-name: ''
        '401':
          description: Unauthorized - Invalid or missing API key
          content:
            application/json:
              schema:
                type: object
                properties:
                  error:
                    type: object
                    properties:
                      message:
                        type: string
                        examples:
                          - Unauthorized
                      type:
                        type: string
                        examples:
                          - authentication_error
                    x-apidog-orders:
                      - message
                      - type
                    x-apidog-ignore-properties: []
                x-apidog-orders:
                  - error
                x-apidog-ignore-properties: []
          headers: {}
          x-apidog-name: ''
        '429':
          description: Rate Limited - Too many requests
          content:
            application/json:
              schema:
                type: object
                properties:
                  error:
                    type: object
                    properties:
                      message:
                        type: string
                        examples:
                          - Rate limit exceeded
                      type:
                        type: string
                        examples:
                          - rate_limit_error
                    x-apidog-orders:
                      - message
                      - type
                    x-apidog-ignore-properties: []
                x-apidog-orders:
                  - error
                x-apidog-ignore-properties: []
          headers: {}
          x-apidog-name: ''
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
      security: []
      x-apidog-folder: docs/en/Market/Chat  Models/Gemini
      x-apidog-status: released
      x-run-in-apidog: https://app.apidog.com/web/project/1184766/apis/api-30445303-run
components:
  schemas:
    Message:
      type: object
      properties:
        role:
          type: string
          enum:
            - developer
            - system
            - user
            - assistant
            - tool
          description: >-
            Message role


            - **developer**: Developer-provided instructions that the model
            should follow, regardless of user messages. In o1 models and newer
            versions, developer messages replace the previous system messages.

            - **system**: Developer-provided instructions that the model should
            follow, regardless of user messages. In o1 models and newer
            versions, please use developer messages instead.

            - **user**: Messages sent by end users, containing prompts or
            additional context information.

            - **assistant**: Messages sent by the model in response to user
            messages.

            - **tool**: Content of tool messages.
        content:
          type: array
          description: >-
            Message content array that can contain text and image objects.


            **Unified Media File Format:**


            Whether it's images, videos, audio, or other document types, all
            media files use the same format structure:


            - The `type` field is always `"image_url"`

            - The `image_url` field name remains unchanged

            - The only thing that changes is the `url` value, which points to
            the corresponding media file address


            For example: images, videos, audio, PDFs, and other documents all
            use the same `{ type: 'image_url', image_url: { url: '...' } }`
            structure.
          items:
            oneOf:
              - type: object
                properties:
                  type:
                    type: string
                    enum:
                      - text
                    examples:
                      - text
                  text:
                    type: string
                    description: 消息的文本内容
                required:
                  - type
                  - text
                x-apidog-orders:
                  - type
                  - text
                x-apidog-ignore-properties: []
              - type: object
                properties:
                  type:
                    type: string
                    enum:
                      - image_url
                    examples:
                      - image_url
                  image_url:
                    type: object
                    properties:
                      url:
                        type: string
                        format: uri
                        description: 图像的 URL
                    required:
                      - url
                    x-apidog-orders:
                      - url
                    x-apidog-ignore-properties: []
                required:
                  - type
                  - image_url
                x-apidog-orders:
                  - type
                  - image_url
                x-apidog-ignore-properties: []
      required:
        - role
        - content
      title: The messages parameter of the chat model
      x-apidog-orders:
        - role
        - content
      x-apidog-ignore-properties: []
      x-apidog-folder: ''
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