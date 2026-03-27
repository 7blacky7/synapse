#import <Foundation/Foundation.h>
#import "SynapseAgent.h"

#define MAX_RETRIES 3
#define DEFAULT_MODEL @"claude-opus-4-6"

static NSInteger agentCount = 0;

typedef NS_ENUM(NSInteger, AgentStatus) {
    AgentStatusActive,
    AgentStatusIdle,
    AgentStatusStopped,
    AgentStatusError
};

@protocol AgentProtocol <NSObject>
- (NSString *)processMessage:(NSString *)message error:(NSError **)error;
- (NSArray<NSString *> *)getTools;
@property (nonatomic, readonly) AgentStatus status;
@end

@interface AgentConfig : NSObject
@property (nonatomic, copy) NSString *model;
@property (nonatomic, assign) NSInteger maxTokens;
@property (nonatomic, assign) double temperature;
+ (instancetype)defaultConfig;
@end

@interface SynapseAgent : NSObject <AgentProtocol>
@property (nonatomic, copy, readonly) NSString *name;
@property (nonatomic, strong) AgentConfig *config;
@property (nonatomic, assign) AgentStatus status;
- (instancetype)initWithName:(NSString *)name config:(AgentConfig *)config;
+ (instancetype)agentWithName:(NSString *)name;
@end

@implementation AgentConfig
+ (instancetype)defaultConfig {
    AgentConfig *config = [[AgentConfig alloc] init];
    config.model = DEFAULT_MODEL;
    config.maxTokens = 4096;
    config.temperature = 0.7;
    return config;
}
@end

@implementation SynapseAgent

- (instancetype)initWithName:(NSString *)name config:(AgentConfig *)config {
    self = [super init];
    if (self) {
        _name = [name copy];
        _config = config ?: [AgentConfig defaultConfig];
        _status = AgentStatusIdle;
        agentCount++;
    }
    return self;
}

+ (instancetype)agentWithName:(NSString *)name {
    return [[self alloc] initWithName:name config:nil];
}

- (NSString *)processMessage:(NSString *)message error:(NSError **)error {
    if (message.length == 0) {
        if (error) *error = [NSError errorWithDomain:@"SynapseAgent" code:400 userInfo:nil];
        return nil;
    }
    self.status = AgentStatusActive;
    NSString *result = [self callModel:message];
    self.status = AgentStatusIdle;
    return result;
}

- (NSArray<NSString *> *)getTools {
    return @[@"search", @"read", @"write"];
}

- (NSString *)callModel:(NSString *)message {
    // TODO: implement actual API call
    return [NSString stringWithFormat:@"Response to: %@", message];
}

- (void)dealloc {
    agentCount--;
}

@end

// FIXME: add proper error domain
