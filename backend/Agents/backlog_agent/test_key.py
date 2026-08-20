import os
from dotenv import load_dotenv
from langchain_nvidia_ai_endpoints import ChatNVIDIA

load_dotenv()

api_key = os.getenv("NVIDIA_API_KEY")
print(f"API Key (first 10 chars): {api_key[:10]}... (len: {len(api_key)})")

try:
    print("Testing connection to NVIDIA API...")
    # Attempt to list available models
    llm = ChatNVIDIA(api_key=api_key)
    models = llm.available_models
    print("\n[SUCCESS] Successfully authenticated!")
    
    # 1. Test basic invoke
    print("\nTesting basic text query with 'nvidia/nemotron-3-nano-30b-a3b'...")
    llm = ChatNVIDIA(model="nvidia/nemotron-3-nano-30b-a3b", api_key=api_key)
    res = llm.invoke("Write a single sentence about coding.")
    print(f"Basic Invoke Result: {res.content}")

    # 2. Test structured output invoke
    from pydantic import BaseModel, Field
    class TestSchema(BaseModel):
        rating: int = Field(..., description="Rating from 1 to 5")
        summary: str = Field(..., description="One word summary")
        
    print("\nTesting structured output query...")
    try:
        structured_llm = llm.with_structured_output(TestSchema)
        res_struct = structured_llm.invoke("Evaluate this phrase: 'Coding is awesome'")
        print(f"Structured Result: {res_struct}")
    except Exception as struct_err:
        print(f"Structured Query failed: {struct_err}")
except Exception as e:
    print(f"\n[ERROR] Connection failed: {e}")
