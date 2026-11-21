"""Retain default secret rules while recognizing two reviewed public token fixtures."""
import base64
import binascii
import json
from pathlib import Path
import re
import sys

PUBLIC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
PUBLIC_EVM_ADDRESS = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"
FIXTURE_PATH = "test/unit/api.test.ts"


def verify_public_contract(value):
    if not isinstance(value, str) or not re.fullmatch(r"C[A-Z2-7]{55}", value):
        raise ValueError("Reviewed fixture must be a canonical public Stellar contract")
    decoded = base64.b32decode(value)
    if (len(decoded) != 35 or decoded[0] != 16
            or decoded[-2:] != binascii.crc_hqx(decoded[:-2], 0).to_bytes(2, "little")):
        raise ValueError("Public contract has an invalid version or checksum")


def configuration():
    verify_public_contract(PUBLIC_CONTRACT)
    root = Path(__file__).resolve().parents[2]
    stellar = json.loads((root / "deployments/testnet.json").read_text())
    evm = json.loads((root / "test/fixtures/deployments-testnet.json").read_text())
    if stellar["networks"]["stellar-testnet"]["tokens"]["USDC"]["sacId"] != PUBLIC_CONTRACT:
        raise ValueError("Reviewed Stellar contract must match the deployment manifest")
    if evm["networks"]["sepolia"]["tokens"]["USDC"]["address"].lower() != PUBLIC_EVM_ADDRESS:
        raise ValueError("Reviewed EVM token must match the deployment fixture")
    values = "|".join(map(re.escape, (PUBLIC_CONTRACT, PUBLIC_EVM_ADDRESS)))
    path = re.escape(FIXTURE_PATH)
    # AND recognizes only these public values at this exact fixture path.
    # The default rule regex, entropy threshold and other secret rules remain intact.
    return f"""[extend]
useDefault = true

[[rules]]
id = "generic-api-key"
[[rules.allowlists]]
description = "Checksum and deployment verified public token contract fixtures, never signing material"
condition = "AND"
regexTarget = "secret"
regexes = ['''^({values})$''']
paths = ['''^{path}$''']
"""


if __name__ == "__main__":
    Path(sys.argv[1]).write_text(configuration())
