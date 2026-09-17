# Synthetic TLS fixture

The PEM pair here was generated solely for the untrusted-certificate routing regression. It is public test material, not an application/provider credential. Never deploy it. Tests must reject it (self-signed, synthetic.invalid subject, deliberately short validity). Keeping this fixture makes tests independent of an installed OpenSSL executable.
